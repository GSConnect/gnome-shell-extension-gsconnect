"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Notify = imports.gi.Notify;

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
            null,
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
        this._fingerprint = "";
        
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
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.id
        );
        
        // Init config
        this.config_cert = Common.CONFIG_PATH + "/" + this.id + "/certificate.pem";
        this.config = Common.readDeviceConfiguration(this.id);
        
        //
        this.activate();
    },
    
    /** Device Properties */
    get connected () { return this._connected; },
    get fingerprint () { return this._fingerprint; },
    get id () { return this.identity.body.deviceId; },
    get name () { return this.identity.body.deviceName; },
    get paired () {
        return GLib.file_test(this.config_cert, GLib.FileTest.EXISTS);
    },
    get plugins () { return Array.from(this._plugins.keys()); },
    get type () { return this.identity.body.deviceType; },
    
    //
    handlePacket: function (packet) {
        log("Device.fromPacket(" + this.id + ")");
        
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
        log("Device.activate(" + this.id + ")");
        
		if (this._channel !== null) {
			log("device already active");
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
        
        this._fingerprint = Common.get_fingerprint(
            this._channel._peer_cert.certificate_pem
        );
        
        this._dbus.emit_property_changed(
            "fingerprint",
            new GLib.Variant("s", this._fingerprint)
        );
        
        this._dbus.emit_property_changed(
            "connected",
            new GLib.Variant("b", this.connected)
        );
    },
    
    _onDisconnected: function (channel) {
        log("Disconnected from '" + this.name + "'");
        
        if (this._channel !== null) {
            this._channel = null;
        }
        
        // This must be done before "connected" is updated
        this._unloadPlugins();
        
        // Remove fingerprint
        this._fingerprint = "";
        this._dbus.emit_property_changed(
            "fingerprint",
            new GLib.Variant("s", this._fingerprint)
        );
        
        // Notify disconnected
        this._connected = false;
        this._dbus.emit_property_changed(
            "connected",
            new GLib.Variant("b", this.connected)
        );
    },
    
    _onReceived: function (channel, packet) {
        log("Received from: " + this.id + ")");
        
        this.handlePacket(packet);
    },
    
    /**
     * Pairing Functions
     *
     * TODO: set timeout for outgoing pair request
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
    
    _cancelPair: function (note) {
        try {
            this._incomingPairRequest = false;
            this._outgoingPairRequest = false;
            note.close();
        } catch (e) {
        }
        return false;
    },
    
    _notifyPair: function (packet) {
        this.emit("pairRequest", this.id); // FIXME: no publicKey?
        
        let note = new Notify.Notification({
            app_name: "GSConnect",
            id: packet.id / 1000,
            summary: _("Pair Request"),
            body: _("%s is requesting pairing").format(this.name),
            icon_name: "channel-insecure-symbolic"
        });
        
        note.add_action(
            "rejectPair",
            _("Reject"),
            Lang.bind(this, this.rejectPair)
        );
        
        note.add_action(
            "acceptPair",
            _("Accept"),
            Lang.bind(this, this.acceptPair)
        );
        
        note.show();
        
        // Start a 30s countdown
        GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            Lang.bind(this, this._cancelPair, note)
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
        log("Device.pair(" + this.name + ")");
        
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
            id: Date.now(),
            type: Protocol.TYPE_PAIR,
            body: { pair: true }
        });
        this._channel.send(packet);
    },
    
    unpair: function () {
        log("Device.unpair(" + this.name + ")");
        
        if (this._channel !== null) {
            let packet = new Protocol.Packet({
                id: Date.now(),
                type: Protocol.TYPE_PAIR,
                body: { pair: false }
            });
            this._channel.send(packet);
        }
        
        this._setPaired(false);
        
        this._unloadPlugins();
    },
    
    acceptPair: function () {
        log("Device.acceptPair(" + this.id + ")");
        
        this._setPaired(true);
        this.pair();
        this._loadPlugins();
    },
    
    rejectPair: function () {
        log("Device.rejectPair(" + this.id + ")");
        
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
                
        this._dbus.emit_property_changed(
            "plugins",
            new GLib.Variant("as", Array.from(this._plugins.keys()))
        );
    },
    
    _unloadPlugins: function () {
        for (let name of this.plugins) {
            this.disablePlugin(name, false);
        }
                
        this._dbus.emit_property_changed(
            "plugins",
            new GLib.Variant("as", Array.from(this._plugins.keys()))
        );
    },
    
    enablePlugin: function (name, write=true) {
        log("Device.enablePlugin(" + name + ", " + write + ")");
    
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
        log("Device.disablePlugin(" + name + ", " + write + ")");
        
        try {
            // Running instance
            if (this.connected) {
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
        log("Device.configurePlugin(" + name + ", " + settings + ")");
        
        try {
            let handler = imports.service.plugins[name];
            
            settings = JSON.parse(settings);
            
            // Check for invalid options
            for (let option in settings) {
                if (!handler.METADATA.settings.hasOwnProperty(option)) {
                    throw Error("Unknown option: " + option);
                }
            }
            
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
    }
});

