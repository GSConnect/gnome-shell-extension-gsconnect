"use strict";

// Imports
const Lang = imports.lang;

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
const Protocol = imports.service.protocol;
const { initTranslations, mergeDeep, DBusInfo, Settings } = imports.common;

const Battery = imports.service.plugins.battery;
const FindMyPhone = imports.service.plugins.findmyphone;
const Notifications = imports.service.plugins.notifications;
const Ping = imports.service.plugins.ping;
const RunCommand = imports.service.plugins.runcommand;
const Share = imports.service.plugins.share;
const Telephony = imports.service.plugins.telephony;


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
        
        this.identity = new Protocol.Packet(packet);
        
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
        this.config_cert = Config.CONFIG_PATH + "/" + this.id + "/certificate.pem";
        this.config = Config.read_device_config(this.id);
        
        //
        this.activate();
    },
    
    /** Device Properties */
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
            this.identity.fromPacket(packet);
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
        
        this._channel.connect("connected", (channel) => {
            log("Connected to: " + this.id);
            
            this._connected = true;
            this._load_plugins();
            
            this._dbus.emit_property_changed(
                "connected",
                new GLib.Variant("b", this.connected)
            );
        });
        
        this._channel.connect("disconnected", (channel) => {
            log("Disconnected from: " + this.id);
            
            if (this._channel !== null) {
                this._channel = null;
            }
            
            this._connected = false;
            this._unload_plugins();
            
            this._dbus.emit_property_changed(
                "connected",
                new GLib.Variant("b", this.connected)
            );
        });
		this._channel.connect("received", (channel, packet) => {
            log("Device._received(" + this.id + ")");
            
            if (packet.type === Protocol.TYPE_PAIR) {
		        this._handle_pair(packet);
		    } else if (this._handlers.has(packet.type)) {
	            this._handlers.get(packet.type).handle_packet(packet);
	        } else {
	            log("Received unsupported packet type: " + packet.toString());
	        }
		});
        
        this._channel.open();
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
        
        let packet = new Protocol.Packet({
            id: Date.now(),
            type: Protocol.TYPE_PAIR,
            body: { pair: true }
        });
        this._channel.send(packet);
    },
    
    // FIXME
    unpair: function () {
        log("Device.unpair(" + this.id + ")");
        
        if (this._channel !== null) {
            let packet = new Protocol.Packet({
                id: Date.now(),
                type: Protocol.TYPE_PAIR,
                body: { pair: false }
            });
            this._channel.send(packet);
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
        
        this.unpair();
        
//        if (this._channel._peer_cert !== null) {
//            this._channel._peer_cert = null;
//        }
    },
    
    /**
     * Plugin Capabilities
     */
    // FIXME: check
    _load_plugins: function () {
        for (let name in this.config.plugins) {
            if (this.config.plugins[name].enabled) {
                this.enablePlugin(name, false);
            }
        }
    },
    
    // FIXME: check
    _unload_plugins: function () {
        for (let name of this.plugins) {
            this.disablePlugin(name, false);
        }
    },
    
    enablePlugin: function (name, write=true) {
        log("Device.enablePlugin(" + name + ", " + write + ")");
    
        if (PacketHandlers.has(name)) {
            let handler = PacketHandlers.get(name);
        
            // Running instance
            if (this.connected && !this._plugins.has(name)) {
                // Enable
                let plugin = new handler.Plugin(this);
                
                // Register packet handlers
                for (let packetType of handler.METADATA.incomingPackets) {
                    this._handlers.set(packetType, plugin);
                }
                
                // Register as enabled
                this._plugins.set(name, plugin);
                
                this._dbus.emit_property_changed(
                    "plugins",
                    new GLib.Variant("as", Array.from(this._plugins.keys()))
                );
            }
            
            // Save config, if requested
            if (write) {
                this.config.plugins[name].enabled = true;
                Config.write_device_config(this.id, this.config);
            }
            
            return true;
        } else {
            return false;
        }
    },
    
    disablePlugin: function (name, write=true) {
        log("Device.disablePlugin(" + name + ", " + write + ")");
        
        if (PacketHandlers.has(name)) {
            // Running instance
            if (this.connected && this._plugins.has(name)) {
                let handler = PacketHandlers.get(name);
                let plugin = this._plugins.get(name);
                
                // Unregister handlers
                for (let packetType of handler.METADATA.incomingPackets) {
                    this._handlers.delete(packetType);
                }
                
                // Register as disabled
                plugin.destroy();
                this._plugins.delete(name);
                
                this._dbus.emit_property_changed(
                    "plugins",
                    new GLib.Variant("as", Array.from(this._plugins.keys()))
                );
            }
            
            // Save config, if requested
            if (write) {
                this.config.plugins[name].enabled = false;
                Config.write_device_config(this.id, this.config);
            }
            
            return true;
        } else {
            return false;
        }
    },
    
    // TODO: check
    configurePlugin: function (name, settings) {
        log("Device.configurePlugin(" + name + ", " + settings + ")");
        
        if (PacketHandlers.has(name)) {
            let handler = PacketHandlers.get(name);
            
            try {
                settings = JSON.parse(settings);
                
                for (let option in settings) {
                    if (!handler.METADATA.settings.hasOwnProperty(option)) {
                        throw Error("Unknown option: " + option);
                    }
                }
            } catch (e) {
                log("Error configuring plugin: " + e);
                return false;
            }
            
            let newSettings = mergeDeep(
                this.config.plugins[name].settings,
                settings
            );
            this.config.plugins[name].settings = newSettings;
            Config.write_device_config(this.id, this.config);

            return true;
        } else {
            return false;
        }
    }
});


var PacketHandlers = new Map([
    ["battery", Battery],
    ["findmyphone", FindMyPhone],
    ["notifications", Notifications],
    ["ping", Ping],
    ["runcommand", RunCommand],
    ["share", Share],
    ["telephony", Telephony]
]);

