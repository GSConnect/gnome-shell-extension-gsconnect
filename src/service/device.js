"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
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

const Config = imports.service.config;
const Plugin = imports.service.plugin;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


var Device = new Lang.Class({
    Name: "GSConnectDevice",
    Extends: GObject.Object,
    Properties: {
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
        "connected": GObject.ParamSpec.boolean(
            "connected",
            "deviceConnected",
            "Whether the device is connected",
            GObject.ParamFlags.READABLE,
            false
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
        // TODO
        this.parent();
        
        this.daemon = daemon;
        this._channel = null;
        this._connected = false;
        
        this.identity = new Protocol.IdentityPacket();
        this.fromPacket(packet);
        
        // Plugins
        this._plugins = new Map();
        this._handlers = new Map();
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.device";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.id
        );
        
        // Init config
        this._init_config();
    },
    
    /**
     * Device Configuration
     */
    _init_config: function () {
        this.config_dir = Config.CONFIG_PATH + "/" + this.id;
        this.config_cert = this.config_dir + "/certificate.pem";
        this.config_device = this.config_dir + "/config.json";
        
        // Plugins
        if (!GLib.file_test(this.config_dir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(this.config_dir, 493);
        }
        
        if (!GLib.file_test(this.config_device, GLib.FileTest.EXISTS)) {
            GLib.file_set_contents(
                this.config_device,
                '{"plugins":[]}'
            );
        }
        
        this._read_config();
    },
    
    // Device Properties
    get connected () { return this._connected; },
    get id () { return this.identity.body.deviceId; },
    get name () { return this.identity.body.deviceName; },
    
    get paired () {
        return GLib.file_test(this.config_cert, GLib.FileTest.EXISTS);
    },
    get plugins () { return Array.from(this._plugins.keys()); },
    get type () { return this.identity.body.deviceType; },
    
    //
    fromPacket: function (packet) {
        log("Device.fromPacket(" + this.id + ")");
        
        if (packet.type === Protocol.TYPE_IDENTITY) {
            Object.assign(this.identity, packet);
        } else {
            throw Error("devices can only be created from identity packets");
        }
        
        this.activate();
    },
    
    activate: function () {
        log("Device.activate(" + this.id + ")");
        
		if (this._channel !== null) {
			log("device already active");
			return;
		}
        
        this._channel = new Protocol.LanChannel(this);
        
        this._channel.connect("connected", () => {
            log("Connected to: " + this.id);
            this._connected = true;
            this._dbus.emit_property_changed(
                "connected",
                new GLib.Variant("b", this._connected)
            );
        });
        this._channel.connect("disconnected", () => {
            log("Disconnected from: " + this.id);
            
            if (this._channel !== null) {
                this._channel.close();
                this._channel = null;
            }
            
            this._connected = false;
            this._dbus.emit_property_changed(
                "connected",
                new GLib.Variant("b", this._connected)
            );
        });
		this._channel.connect("received", Lang.bind(this, this._received));
        
        this._channel.open();
    },
    
    /**
     * Packet Handling
     */
    
    // TODO
    _received: function (channel, packet) {
        log("Device._received(" + this.id + ")");
        
        if (packet.type === Protocol.TYPE_PAIR) {
		    log(this.id + ": pair packet received: " + packet.toData());
		    this._handle_pair(packet);
		} else if (this._handlers.has(packet.type)) {
	        log("Received '" + packet.type + "' from '" + this.name + "'");
	        let handler = this._handlers.get(packet.type);
	        handler.handle_packet(packet);
	    } else {
	        log("Received unsupported packet type: " + packet.type);
	    }
    },
    
    /**
     * Pairing Functions
     */
    _handle_pair: function (packet) {
        if (packet.body.pair) {
            if (this.paired) {
                log("already paired?");
                this.pair();
            } else {
                log("not paired?");
                
                // FIXME: notify user now
                log("FIXME: emitting pairRequest signal");
                this.emit("pairRequest", this.id); // FIXME: no publicKey?
                
                // FIXME: we're auto-accepting right now
                log("FIXME: auto-accepting pair request");
                this.acceptPair();
                this.pair();
            }
        } else {
            GLib.unlink(this.config_cert);
            this._dbus.emit_property_changed(
                "paired",
                new GLib.Variant("b", this.paired)
            );
        }
    },
    
    // FIXME
    pair: function () {
        log("Device.pair(" + this.id + ")");
        let pairPacket = new Protocol.PairPacket(this.daemon);
        this._channel.send(pairPacket);
    },
    
    // FIXME
    unpair: function () {
        log("Device.unpair(" + this.id + ")");
        
        if (this._channel !== null) {
            let unpairPacket = new Protocol.PairPacket();
            this._channel.send(unpairPacket);
        }
        
        GLib.unlink(this.config_cert);
        this._dbus.emit_property_changed(
            "paired",
            new GLib.Variant("b", this.paired)
        );
    },
    
    // FIXME
    acceptPair: function () {
        log("Device.acceptPair(" + this.id + ")");
        
        if (this._channel._peer_cert !== null) {
            GLib.file_set_contents(
                this.config_cert,
                this._channel._peer_cert.certificate_pem,
                this._channel._peer_cert.certificate_pem.length,
                null
            );
            this._dbus.emit_property_changed(
                "paired",
                new GLib.Variant("b", this.paired)
            );
        } else {
            log("Failed to accept pair: no certificate stashed");
        }
    },
    
    // FIXME
    rejectPair: function () {
        log("Device.rejectPair(" + this.id + ")");
        if (this._channel._peer_cert !== null) {
            this._channel._peer_cert = null;
        }
    },
    
    /**
     * Plugin Capabilities
     */
     // FIXME: check
    _read_config: function () {
        let config = GLib.file_get_contents(this.config_device)[1].toString();
        this.config = JSON.parse(config);
        
        for (let plugin of this.config.plugins) {
            this.enablePlugin(plugin, false);
        }
    },
    
    // FIXME: check
    _write_config: function () {
        this.config.plugins = this.plugins;
        GLib.file_set_contents(
            this.config_device,
            JSON.stringify(this.config)
        );
    },
    
    enablePlugin: function (name, write=true) {
        log("Device.enablePlugin(" + name + ", " + write + ")");
    
        if (Plugin.PluginMap.has(name) && !this._plugins.has(name)) {
            // Enable
            let handlerClass = Plugin.PluginMap.get(name);
            let plugin = new handlerClass(this);
            
            // Register packet handlers
            for (let packetType of plugin.incomingPackets) {
                this._handlers.set(packetType, plugin);
            }
            
            // Register as enabled
            this._plugins.set(name, plugin);
            
            this._dbus.emit_property_changed(
                "plugins",
                new GLib.Variant("as", Array.from(this._plugins.keys()))
            );
            
            // Save config, if requested
            if (write) { this._write_config(); }
            
            return true;
        } else {
            return false;
        }
    },
    
    disablePlugin: function (name, write=true) {
        log("Device.disablePlugin(" + name + ", " + write + ")");
        
        if (Plugin.PluginMap.has(name) && this._plugins.has(name)) {
            let plugin = this._plugins.get(name);
            
            // Unregister handlers
            for (let packetType of plugin.incomingPackets) {
                this._handlers.delete(packetType);
            }
            
            // Register as disabled
            plugin.destroy();
            this._plugins.delete(name);
            
            this._dbus.emit_property_changed(
                "plugins",
                new GLib.Variant("as", Array.from(this._plugins.keys()))
            );
            
            // Save config, if requested
            if (write) { this._write_config(); }
            
            return true;
        } else {
            return false;
        }
    }
});

