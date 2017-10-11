"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;


var Device = new Lang.Class({
    Name: "GSConnectDevice",
    Extends: GObject.Object,
    Properties: {
        "connected": GObject.ParamSpec.boolean(
            "connected",
            "deviceConnected",
            "Whether the device is connected",
            GObject.ParamFlags.READABLE,
            false
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "deviceFingerprint",
            "SHA1 fingerprint for the device certificate",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "id": GObject.ParamSpec.string(
            "id",
            "deviceId",
            "The device id/hostname",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "deviceName",
            "The device name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "paired": GObject.ParamSpec.boolean(
            "paired",
            "devicePaired",
            "Whether the device is paired",
            GObject.ParamFlags.READABLE,
            false
        ),
        "plugins": GObject.param_spec_variant(
            "plugins",
            "PluginsList", 
            "A list of enabled plugins",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "supportedPlugins": GObject.param_spec_variant(
            "supportedPlugins",
            "SupportedPluginsList", 
            "A list of supported plugins",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "deviceType",
            "The device type",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    Signals: {
        "pairRequest": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (daemon, packet) {
        this.parent();
        
        this.daemon = daemon;
        this._channel = null;
        this._connected = false;
        
        this._incomingPairRequest = false;
        this._outgoingPairRequest = false;
        
        this.identity = new Protocol.Packet(packet);
        
        // Plugins
        this._plugins = new Map();
        this._handlers = new Map();
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.device";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(Gio.DBus.session, Common.dbusPathFromId(this.id));
        
        // Init config
        this.config_cert = Common.CONFIG_PATH + "/" + this.id + "/certificate.pem";
        this.config = Common.readDeviceConfiguration(this.id);
        
        //
        this.activate();
    },
    
    /** Device Properties */
    get connected () { return this._connected; },
    get fingerprint () {
        if (this.connected) {
            return Common.getFingerprint(
                this._channel._peer_cert.certificate_pem
            );
        } else if (this.paired) {
            return Common.getFingerprint(
                GLib.file_get_contents(this.config_cert)[1].toString()
            );
        }
        
        return "";
    },
    get id () { return this.identity.body.deviceId; },
    get name () { return this.identity.body.deviceName; },
    get paired () {
        return GLib.file_test(this.config_cert, GLib.FileTest.EXISTS);
    },
    get plugins () { return Array.from(this._plugins.keys()); },
    get supportedPlugins () {
        let plugins = [];
        let incoming = this.identity.body.incomingCapabilities;
        let outgoing = this.identity.body.outgoingCapabilities;
        
        for (let name of Common.findPlugins()) {
            let metadata = imports.service.plugins[name].METADATA;
            let supported = false;
            
            if (metadata.incomingPackets.some(v => outgoing.indexOf(v) >= 0)) {
                plugins.push(name);
                supported = true;
            }
            
            if (supported) { continue; }
            
            if (metadata.outgoingPackets.some(v => incoming.indexOf(v) >= 0)) {
                plugins.push(name);
            }
        }
        
        return plugins.sort();
    },
    get type () { return this.identity.body.deviceType; },
    
    //
    handlePacket: function (packet) {
        Common.debug("Device.fromPacket(" + this.id + ")");
        
        if (packet.type === Protocol.TYPE_IDENTITY) {
            this.identity.fromPacket(packet);
            this.activate();
        } else if (packet.type === Protocol.TYPE_PAIR) {
	        this._handlePair(packet);
	    } else if (this._handlers.has(packet.type)) {
            this._handlers.get(packet.type).handlePacket(packet);
        } else {
            log("Received unsupported packet type: " + packet.toString());
        }
    },
    
    activate: function () {
        Common.debug("Device.activate(" + this.id + ")");
        
		if (this._channel !== null) {
			Common.debug("device already active");
			return;
		}
        
        this._channel = new Protocol.LanChannel(this);
        
        this._channel.connect("connected", Lang.bind(this, this._onConnected));
        this._channel.connect("disconnected", Lang.bind(this, this._onDisconnected));
		this._channel.connect("received", Lang.bind(this, this._onReceived));
        
        this._channel.open();
    },
    
    _onConnected: function (channel) {
        log("Connected to '" + this.name + "'");
        
        this._connected = true;
        
        this._loadPlugins();
        
        this._dbus.emit_property_changed(
            "connected",
            new GLib.Variant("b", this.connected)
        );
        
        // Ensure fingerprint is available right away
        this._dbus.emit_property_changed(
            "fingerprint",
            new GLib.Variant("s", this.fingerprint)
        );
    },
    
    // TODO: see destroy()
    _onDisconnected: function (channel) {
        log("Disconnected from '" + this.name + "'");
        
        try {
            if (this._channel !== null) {
                this._channel = null;
            }
            
            // This must be done before "connected" is updated
            this._unloadPlugins();
        
            // Notify disconnected
            this._connected = false;
            this._dbus.emit_property_changed(
                "connected",
                new GLib.Variant("b", this.connected)
            );
        } catch (e) {
            Common.debug("Device: error disconnecting: " + e);
        }
    },
    
    _onReceived: function (channel, packet) {
        Common.debug("Received from '" + this.name + "'");
        
        this.handlePacket(packet);
    },
    
    /**
     * Pairing Functions
     *
     */
    _handlePair: function (packet) {
        log("Pair request: " + this.name + " (" + this.id + ")");
        
        // A pair has been requested
        if (packet.body.pair) {
            // The device is responding to our request
            if (this._outgoingPairRequest) {
                this._outgoingPairRequest = false;
                this._setPaired(true);
                this._loadPlugins();
            // We're already paired, inform the device
            } else if (this.paired) {
                this.pair();
            // This is a new pair request, inform the user
            } else {
                this._incomingPairRequest = true;
                this._notifyPair(packet);
            }
        // Device has requested unpairing
        } else {
            this.unpair();
        }
    },
    
    // FIXME: doesn't this always happen then?
    _cancelPair: function () {
        try {
            this._incomingPairRequest = false;
            this._outgoingPairRequest = false;
            this.daemon.withdraw_notification("pair-request");
            this.unpair();
        } catch (e) {
        }
        return false;
    },
    
    _notifyPair: function (packet) {
        // TODO: no publicKey?
        this.emit("pairRequest", this.id);
        this._dbus.emit_signal(
            "pairRequest",
            new GLib.Variant("(s)", [this.id])
        );
        
        let notif = new Gio.Notification();
        // TRANSLATORS: eg. Pair Request from Google Pixel
        notif.set_title(_("Pair Request from %s").format(this.name));
        notif.set_body(
            _("%s Fingerprint:\n%s\n\nLocal Fingerprint:\n%s").format(
                this.name,
                this.fingerprint,
                this.daemon.fingerprint
            )
        );
        notif.set_icon(new Gio.ThemedIcon({ name: "channel-insecure-symbolic" }));
        
        notif.add_button(
            _("Reject"),
            "app.pairAction(('" + this._dbus.get_object_path() + "','reject'))"
        );
        notif.add_button(
            _("Accept"),
            "app.pairAction(('" + this._dbus.get_object_path() + "','accept'))"
        );
        
        this.daemon.send_notification("pair-request", notif);
        
        // Start a 30s countdown
        GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            Lang.bind(this, this._cancelPair)
        );
    },
    
    _setPaired: function (bool) {
        this._incomingPairRequest = false;
        this._outgoingPairRequest = false;
        
        if (bool) {
            GLib.file_set_contents(
                this.config_cert,
                this._channel._peer_cert.certificate_pem
            );
        } else {
            GLib.unlink(this.config_cert);
        }
        
        this._dbus.emit_property_changed("paired", new GLib.Variant("b", bool));
    },
    
    pair: function () {
        Common.debug("Device.pair(" + this.id + ")");
        
        // We're initiating an outgoing request
        if (!this.paired) {
            this._outgoingPairRequest = true;
        
            GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                30,
                Lang.bind(this, this._cancelPair)
            );
        }
        
        // Send a pair packet
        let packet = new Protocol.Packet({
            id: 0,
            type: Protocol.TYPE_PAIR,
            body: { pair: true }
        });
        this._channel.send(packet);
    },
    
    unpair: function () {
        Common.debug("Device.unpair(" + this.id + ")");
        
        if (this._channel !== null) {
            let packet = new Protocol.Packet({
                id: 0,
                type: Protocol.TYPE_PAIR,
                body: { pair: false }
            });
            this._channel.send(packet);
        }
        
        this._unloadPlugins();
        
        this._setPaired(false);
    },
    
    acceptPair: function () {
        Common.debug("Device.acceptPair(" + this.id + ")");
        
        this._setPaired(true);
        this.pair();
        this._loadPlugins();
    },
    
    rejectPair: function () {
        Common.debug("Device.rejectPair(" + this.id + ")");
        
        this.unpair();
    },
    
    /**
     * Plugin Capabilities
     */
    _loadPlugins: function () {
        for (let name in this.config.plugins) {
            if (this.config.plugins[name].enabled) {
                this.enablePlugin(name, false);
            }
        }
                
        this.notify("plugins");
        this._dbus.emit_property_changed(
            "plugins",
            new GLib.Variant("as", Array.from(this._plugins.keys()))
        );
    },
    
    _unloadPlugins: function () {
        for (let name of this.plugins) {
            this.disablePlugin(name, false);
        }
        
        this.notify("plugins");
        this._dbus.emit_property_changed(
            "plugins",
            new GLib.Variant("as", Array.from(this._plugins.keys()))
        );
    },
    
    enablePlugin: function (name, write=true) {
        Common.debug("Device.enablePlugin(" + name + ", " + write + ")");
    
        try {
            let handler = imports.service.plugins[name];
        
            // Running instance
            if (this.connected && this.paired) {
                // Enable
                let plugin = new handler.Plugin(this);
                
                // Register packet handlers
                for (let packetType of handler.METADATA.incomingPackets) {
                    if (!this._handlers.has(packetType)) {
                        this._handlers.set(packetType, plugin);
                    }
                }
                
                // Register as enabled
                if (!this._plugins.has(name)) {
                    this._plugins.set(name, plugin);
                }
            }
            
            // Save config and notify, if requested
            if (write) {
                this.config.plugins[name].enabled = true;
                Common.writeDeviceConfiguration(this.id, this.config);
                
                this.notify("plugins");
                this._dbus.emit_property_changed(
                    "plugins",
                    new GLib.Variant("as", Array.from(this._plugins.keys()))
                );
            }
            
            return true;
        } catch (e) {
            log("Error enabling plugin '" + name + "': " + e);
            return false;
        }
    },
    
    disablePlugin: function (name, write=true) {
        Common.debug("Device.disablePlugin(" + name + ", " + write + ")");
        
        try {
            // Running instance
            if (this.connected && this.paired) {
                let handler = imports.service.plugins[name];
                let plugin = this._plugins.get(name);
                
                // Unregister handlers
                for (let packetType of handler.METADATA.incomingPackets) {
                    this._handlers.delete(packetType);
                }
                
                // Register as disabled
                plugin.destroy();
                this._plugins.delete(name);
            }
            
            // Save config and notify, if requested
            if (write) {
                this.config.plugins[name].enabled = false;
                Common.writeDeviceConfiguration(this.id, this.config);
                
                this.notify("plugins");
                this._dbus.emit_property_changed(
                    "plugins",
                    new GLib.Variant("as", Array.from(this._plugins.keys()))
                );
            }
            
            return true;
        } catch (e) {
            log("Error disabling plugin '" + name + "': " + e);
            return false;
        }
    },
    
    configurePlugin: function (name, settings) {
        Common.debug("Device.configurePlugin(" + name + ", " + settings + ")");
        
        try {
            let handler = imports.service.plugins[name];
            
            settings = JSON.parse(settings);
            
            // Write the new configuration
            Object.assign(this.config.plugins[name].settings, settings);
            Common.writeDeviceConfiguration(this.id, this.config);
            
            // Update the device with the new configuration
            if (this.connected && this.paired && this._plugins.has(name)) {
                this._plugins.get(name).reconfigure();
            }

            return true;
        } catch (e) {
            log("Error configuring plugin '" + name + "': " + e);
            return false;
        }
    },
    
    reloadPlugins: function () {
        this._unloadPlugins();
        this._loadPlugins();
    },
    
    destroy: function () {
        if (this.connected) {
            this._channel.close();
        }
        
        // TODO: it would be nice not to have to do this here
        for (let [name, plugin] of this._plugins) {
            plugin.destroy();
        }
        
        // TODO: this is causing errors to be thrown in _onDisconnected()
        //       because it gets called before the channel fully closes
        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    }
});

