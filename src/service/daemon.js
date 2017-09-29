#!/usr/bin/env gjs

"use strict";

// Imports
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const System = imports.system;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Notify = imports.gi.Notify;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Config = imports.service.config;
const Device = imports.service.device;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


var Daemon = new Lang.Class({
    Name: "GSConnectDaemon",
    Extends: Gtk.Application,
    Properties: {
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The name announced to the network",
            GObject.ParamFlags.READWRITE,
            "Gnome Shell"
        ),
        "certificate": GObject.ParamSpec.object(
            "certificate",
            "TlsCertificate",
            "The local TLS Certificate",
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'devices': GObject.param_spec_variant(
            'devices',
            'DevicesList', 
            'A list of known devices',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    },

    _init: function() {
        this.parent({
            application_id: 'org.gnome.shell.extensions.gsconnect.daemon',
            flags: Gio.ApplicationFlags.FLAGS_NONE
        });
        
        let application_name = _("GSConnect");

        GLib.set_prgname(application_name);
        GLib.set_application_name(application_name);
        
        //
        this._debug_mode = null;
        
        // FIXME
        this._discovery = 0
        this._discoverers = [];
        
        // Options
        this.add_main_option(
            "debug",
            "d".charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            "Debug Mode",
            null
        );
        
        this.register(null);
    },
    
    // Properties
    get certificate () {
        return Gio.TlsCertificate.new_from_files(
            Config.CONFIG_PATH + "/certificate.pem",
            Config.CONFIG_PATH + "/private.pem"
        );
    },
    
    get name() {
        return this.identity.body.deviceName;
    },
    
    set name(name) {
        this.identity.body.deviceName = name;
        Config.write_daemon_config(this);
        this._dbus.emit_property_changed("name", new GLib.Variant("s", name));
        this.broadcast();
    },
    
    get devices() {
        return Array.from(this._devices.keys());
    },
    
    // Methods
    broadcast: function () {
        log("Daemon.broadcast()");
        
        this._socket.send_to(
            this._broadcastAddr,
            this.identity.toData(),
            null
        );
    },
    
    // FIXME: this is all pretty complicated
    discover: function (name, timeout=0) {
        let index_ = this._discoverers.indexOf(name);
        
        // We're removing a request
        if (index_ > -1) {
            this._discoverers.splice(index_, 1);
        // We're adding a request
        } else {
            // If there's a timeout we'll add a loop for that
            if (timeout > 0) {
                GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    timeout,
                    () => {
                        let index_ = this._discoverers.indexOf(name);
                        
                        if (index_ > -1) {
                            this._discoverers.splice(index_, 1);
                        }
                        
                        return false;
                    }
                );
            }
        
            // Add it to the list of discoverers
            this._discoverers.push(name);
            
            // Only run one source at a time
            if (this._discovery <= 0) {
                this._discovery = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    1,
                    () => {
                        if (this._discoverers.length) {
                            this.broadcast();
                            return true;
                        }
                        
                        GLib.source_remove(this._discovery);
                        this._discovery = 0;
                        return false;
                    }
                );
            }
        }
    },
    
    // Special method to accomodate nautilus-send-gsconnect.py
    getShareable: function () {
        let shareable = {};
        
        for (let [busPath, device] of this._devices.entries()) {
            if (device.connected && device._plugins.has("share")) {
                shareable[device.name] = device.id;
            }
        }
        
        return shareable;
    },
    
    _addDevice: function (packet) {
        let devObjPath = "/org/gnome/shell/extensions/gsconnect/device/";
        
        if (this._devices.has(devObjPath + packet.body.deviceId)) {
            log("updating device");
            
            let device = this._devices.get(devObjPath + packet.body.deviceId);
            device.handlePacket(packet);
        } else {
            log("creating device");
            
            let device = new Device.Device(this, packet)
            this._devices.set(devObjPath + packet.body.deviceId, device);
            
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
        
        Config.write_device_cache(this, packet.body.deviceId);
    },
    
    /**
     * Start listening for incoming broadcast packets
     *
     * TODO: TCP Listener that supports a range of ports (1716-1764)
     */
    _listen: function () {
        this._socket = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        
        // TODO: support a range of ports
        this._listenAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
            port: this.identity.body.tcpPort
        });
        
        this._broadcastAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string("255.255.255.255"),
            port: this.identity.body.tcpPort
        });
        
        this._in = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._socket.fd })
        });

        try {
            this._socket.init(null);
            this._socket.bind(this._listenAddr, false);
        } catch (e) {
            this._socket.close();
            this._socket = null;
            throw e;
        }
        
        // Watch for incoming packets
        let source = this._socket.create_source(GLib.IOCondition.IN, null);
        source.set_callback(Lang.bind(this, this._received));
        source.attach(null);
        
        log("listening for new devices on '0.0.0.0:" + this._listenAddr.port);
    },
    
    _received: function (socket, condition) {
        log("Daemon._received()");
        
        let addr, data, flags, size;
        
        try {
            // "Peek" the incoming address
            [size, addr, data, flags] = this._socket.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._in.read_line(null);
            log("Daemon received: " + data);
        } catch (e) {
            log("error reading data: " + e);
        }
        
        let packet = new Protocol.Packet(data.toString());
        
        if (packet.type !== Protocol.TYPE_IDENTITY) {
            log("Unexpected packet type: " + packet.type);
            return true;
        } else if (packet.body.deviceId === this.identity.body.deviceId) {
            log("Ignoring self-broadcast");
            return true;
        }
        
        packet.body.tcpHost = addr.address.to_string();
        
        // Init device
        this._addDevice(packet);
        
        return true;
    },


    /**
     * GApplication functions
     */
    vfunc_startup: function() {
        this.parent();
        
        // Manager setup
        this._devices = new Map();
        this._socket = null;
        this._in = null;
        
        this.identity = new Protocol.Packet();
        Config.init_config(this);
        
        // Notifications
        Notify.init("org.gnome.shell.extensions.gsconnect.daemon");
        
        // Debug Mode
        if (this._debug_mode) {
            GLib.setenv("G_MESSAGES_DEBUG", "all", true);
        }
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.daemon";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.daemon.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/daemon"
        );
        
        // Listen for new devices
        try {
            this._listen();
        } catch (e) {
            log("error listening: " + e);
        }
        
        // Load cached devices
        for (let identity of Config.read_device_cache()) {
            let packet = new Protocol.Packet(identity);
            this._addDevice(packet);
        }
        log(this._devices.size + " devices loaded from cache");
        
        this.broadcast();
    },

    vfunc_activate: function() {
        this.parent();
        this.hold();
    },

    vfunc_shutdown: function() {
        this.parent();
        
        if (this._socket !== null) {
            this._socket.close();
        }
        
        Notify.uninit();
    },
    
    vfunc_handle_local_options: function(options) {
        if (options.contains("debug")) {
            this._debug_mode = true;
        }
        
        return -1;
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

