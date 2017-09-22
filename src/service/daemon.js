#!/usr/bin/env gjs

"use strict";

// Imports
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const System = imports.system;

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

const Config = imports.service.config;
const Device = imports.service.device;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


var Daemon = new Lang.Class({
    Name: "GSConnectDaemon",
    Extends: Gio.Application,
    Properties: {
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The name announced to the network",
            GObject.ParamFlags.READABLE,
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
        ),
        "publicKey": GObject.ParamSpec.string(
            "publicKey",
            "RsaPublicKey",
            "The local RSA Public Key",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    // FIXME: this is emitted when a device is "discovered", with a device obj
    // TODO: magical DBus notification
    Signals: {
        "device": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
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
    
    get publicKey() {
        return GLib.file_get_contents(
            Config.CONFIG_PATH + "/public.pem"
        )[1].toString();
    },
    
    get name() {
        return this.identity.body.deviceName;
    },
    
    set name(name) {
        this.identity.body.deviceName = name;
        this._write_config();
    },
    
    get devices() {
        return Array.from(this._devices.keys());
    },
    
    // Methods
    broadcast: function () {
        log("Daemon.broadcast()");
        
        let ident = new Protocol.IdentityPacket(this);
        this._socket.send_to(this._broadcastAddr, ident.toData(), null);
    },
    
    /**
     * Start listening for incoming broadcast packets
     *
     * TODO: support a range of ports
     */
    listen: function () {
        this._socket = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP
        });
        
        // TODO: support a range of ports
        this._listenAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
            port: this.identity.body.tcpPort
        });
        
        this._broadcastAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string("0.0.0.0"),
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
        
        log(
            "GSConnect: listening for new devices on: " +
            this._listenAddr.address.to_string() + ":" +
            this._listenAddr.port
        );
        
        this.broadcast();
    },
    
    _received: function (socket, condition) {
        log("Daemon._received()");
        
        let addr, data, flags, size;
        
        try {
            [size, addr, data, flags] = this._socket.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._in.read_line(null);
        } catch (e) {
            log("error reading data: " + e);
        }
        
        // Ignore local broadcasts
        if (addr.address.to_string() === "127.0.0.1") { return true; }
        
        let packet = new Protocol.Packet(data);
        
        if (packet.type !== Protocol.TYPE_IDENTITY) {
            log("Unexpected packet type: " + packet.type);
            return true;
        }
        
        packet.body.tcpHost = addr.address.to_string();
        
        // Init device
        if (this._devices.has(packet.body.deviceId)) {
            log("updating device");
            
            let device = this._devices.get(packet.body.deviceId);
            device.fromPacket(packet);
        } else {
            log("creating device");
            
            let device = new Device.Device(this, packet)
            this._devices.set(packet.body.deviceId, device);
        }
        
        // update cache
        Config.write_device_cache(this, packet.body.deviceId);
        
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
        
        this.identity = new Protocol.IdentityPacket();
        Config.init_config(this);
        
        // Notifications
        //Notify.init("gnome-shell-extension-gsconnect.daemon");
        
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
            this.listen();
        } catch (e) {
            log("error listening: " + e);
        }
        
        // Load cached devices
        for (let identity of Config.read_device_cache()) {
            let packet = new Protocol.Packet(identity);
            let device = new Device.Device(this, packet);
            this._devices.set(packet.body.deviceId, device);
        }
        log(this._devices.size + " devices loaded from cache");
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

