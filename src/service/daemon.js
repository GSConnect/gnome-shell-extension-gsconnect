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

const Common = imports.common;
const Device = imports.service.device;
const Protocol = imports.service.protocol;


var Daemon = new Lang.Class({
    Name: "GSConnectDaemon",
    Extends: Gtk.Application,
    Properties: {
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The name announced to the network",
            GObject.ParamFlags.READWRITE,
            "GSConnect"
        ),
        "certificate": GObject.ParamSpec.object(
            "certificate",
            "TlsCertificate",
            "The local TLS Certificate",
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        "devices": GObject.param_spec_variant(
            "devices",
            "DevicesList", 
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "deviceFingerprint",
            "SHA1 fingerprint for the device certificate",
            GObject.ParamFlags.READABLE,
            ""
        )
    },

    _init: function() {
        this.parent({
            application_id: "org.gnome.shell.extensions.gsconnect.daemon",
            flags: Gio.ApplicationFlags.FLAGS_NONE
        });
        
        let application_name = _("GSConnect");

        GLib.set_prgname(application_name);
        GLib.set_application_name(application_name);
        
        // FIXME
        this._discovery = 0
        this._discoverers = [];
        
        this.register(null);
    },
    
    // Properties
    get certificate () {
        return Gio.TlsCertificate.new_from_files(
            Common.CONFIG_PATH + "/certificate.pem",
            Common.CONFIG_PATH + "/private.pem"
        );
    },
    
    get devices() {
        return Array.from(this._devices.keys());
    },
    
    get fingerprint () {
        return Common.getFingerprint(
            GLib.file_get_contents(
                Common.CONFIG_PATH + "/certificate.pem"
            )[1].toString()
        );
    },
    
    get name() {
        return Common.Settings.get_string("public-name");
    },
    
    set name(name) {
        Common.Settings.set_string("public-name", name);
        this._dbus.emit_property_changed("name", new GLib.Variant("s", name));
        this.broadcast();
    },
    
    /**
     * Special method to accomodate nautilus-gsconnect.py
     *
     * FIXME: it's ugly!
     */
    getShareable: function () {
        let shareable = {};
        
        for (let [busPath, device] of this._devices.entries()) {
            if (device.connected && device._plugins.has("share")) {
                shareable[device.name] = device.id;
            }
        }
        
        return shareable;
    },
    
    /**
     * Get the local device type from "chassis_type"
     */
    _getDeviceType: function () {
        let proc = GLib.spawn_async_with_pipes(
            null,                                       // working dir
            ["cat", "/sys/class/dmi/id/chassis_type"],  // argv
            null,                                       // envp
            GLib.SpawnFlags.SEARCH_PATH,                // enables PATH
            null                                        // child_setup (func)
        );
        
        let stdout = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: proc[3] })
        });
        let chassisInt = stdout.read_line(null)[0].toString();
        stdout.close(null);
        
        if (["8", "9", "10", "14"].indexOf(chassisInt) > -1) {
            return "laptop";
        } else {
            return "desktop";
        }
    },
    
    /**
     * Programmatically build an identity packet
     */
    _getIdentityPacket: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: Protocol.TYPE_IDENTITY,
            body: {
                deviceId: "GSConnect@" + GLib.get_host_name(),
                deviceName: this.name,
                deviceType: this._getDeviceType(),
                tcpPort: this._listener.local_address.port,
                protocolVersion: 7,
                incomingCapabilities: [],
                outgoingCapabilities: []
            }
        });
        
        for (let name of Common.findPlugins()) {
            let metadata = imports.service.plugins[name].METADATA;
            
            for (let packetType of metadata.incomingPackets) {
                packet.body.incomingCapabilities.push(packetType);
            }
            
            for (let packetType of metadata.outgoingPackets) {
                packet.body.outgoingCapabilities.push(packetType);
            }
        }
        
        return packet;
    },
    
    /**
     * Discovery Methods
     *
     * TODO: cleanup discover()
     * TODO: export a "discovering" property
     * TODO: error check broadcast()?
     */
    broadcast: function () {
        Common.debug("Daemon.broadcast()");
        
        this._listener.send_to(
            this._broadcastAddr,
            this.identity.toData(),
            null
        );
    },
    
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
    
    /**
     * Device Methods
     */
    _readCache: function () {
        let config_dir = Gio.File.new_for_path(Common.CONFIG_PATH);
        
        let fenum = config_dir.enumerate_children(
            "standard::name,standard::type,standard::size",
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        
        let item, info;
        let devices = [];
        
        while ((info = fenum.next_file(null))) {
            let file = fenum.get_child(info);
            
            let identPath = file.get_path() + "/identity.json"
            
            if (GLib.file_test(identPath, GLib.FileTest.EXISTS)) {
                let [success, data] = GLib.file_get_contents(identPath);
                devices.push(JSON.parse(data));
            }
        }
        
        return devices;
    },
    
    _writeCache: function (deviceId=false) {
        if (deviceId) {
            Common.debug("Daemon: Updating cache for: " + deviceId);
            
            let device = this._devices.get(Common.dbusPathFromId(deviceId));
            
            let deviceDir = Common.CONFIG_PATH + "/" + device.id;
            
            if (!GLib.file_test(deviceDir, GLib.FileTest.IS_DIR)) {
                GLib.mkdir_with_parents(deviceDir, 493);
            }
            
            // Identity
            GLib.file_set_contents(
                deviceDir + "/identity.json",
                JSON.stringify(device.identity)
            );
        } else {
            for (let device of this._devices.values()) {
                this._writeCache(device.deviceId);
            }
        }
    },
    
    _watchCache: function () {
        let cacheDir = Gio.File.new_for_path(Common.CONFIG_PATH);
        this.cacheMonitor = cacheDir.monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this.cacheMonitor.connect("changed", (monitor, file, ofile, event) => {
            let dbusPath = Common.dbusPathFromId(file.get_basename());
            
            if (this._devices.has(dbusPath) && (event === 2 || event === 10)) {
                this._removeDevice(dbusPath);
            } else if (event === 3 || event === 9) {
                this._readCache();
            }
        });
    },
    
    _addDevice: function (packet) {
        let devObjPath = Common.dbusPathFromId(packet.body.deviceId);
        
        if (this._devices.has(devObjPath)) {
            Common.debug("updating device");
            
            let device = this._devices.get(devObjPath);
            device.handlePacket(packet);
        } else {
            Common.debug("creating device");
            
            let device = new Device.Device(this, packet)
            this._devices.set(devObjPath, device);
            
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
        
        this._writeCache(packet.body.deviceId);
    },
    
    /**
     * Start listening for incoming broadcast packets
     *
     * FIXME: conflicts with running KDE Connect, for some reason
     * TODO: TCP Listener
     */
    _listen: function (port=1716) {
        this._listener = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        this._listener.init(null);

        while (true) {
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: port
            });
        
            try {
                this._listener.bind(addr, false);
            } catch (e) {
                Common.debug("failed to bind to port: " + port);
                
                if (port < 1764) {
                    port += 1;
                } else {
                    this._listener.close();
                    throw Error("Unable to bind listener");
                }
            }
            
            break;
        }
        
        // Broadcast Address
        this._broadcastAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string("255.255.255.255"),
            port: this._listener.local_address.port
        });
        
        this._in = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._listener.fd })
        });
        
        // Watch for incoming packets
        let source = this._listener.create_source(GLib.IOCondition.IN, null);
        source.set_callback(Lang.bind(this, this._received));
        source.attach(null);
        
        log("listening for new devices on 0.0.0.0:" + port);
    },
    
    _received: function (socket, condition) {
        Common.debug("Daemon._received()");
        
        let addr, data, flags, size;
        
        try {
            // "Peek" the incoming address
            [size, addr, data, flags] = this._listener.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._in.read_line(null);
        } catch (e) {
            log("Daemon: Error reading data: " + e);
            return;
        }
        
        let packet = new Protocol.Packet(data.toString());
        
        if (packet.type !== Protocol.TYPE_IDENTITY) {
            Common.debug("Daemon: Unexpected packet type: " + packet.type);
            return true;
        } else if (packet.body.deviceId === this.identity.body.deviceId) {
            return true;
        } else {
            Common.debug("Daemon received: " + data);
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
        this._in = null;
        this._listener = null;
        
        // Intitialize configuration and choke hard if it fails
        if (!Common.initConfiguration()) { this.vfunc_shutdown(); }
        
        // Notifications
        Notify.init("org.gnome.shell.extensions.gsconnect.daemon");
        
        // Icon Fallbacks
        Gtk.IconTheme.get_default().add_resource_path("/icons");
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.daemon";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.daemon.lookup_interface(iface),
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
            log("Error starting listener: " + e);
            this.vfunc_shutdown();
        }
        
        this.identity = this._getIdentityPacket();
        
        // Monitor network changes
        this._netmonitor = Gio.NetworkMonitor.get_default();
        this._netmonitor.connect("network-changed", (monitor, available) => {
            if (available) {
                this.broadcast();
            }
        });
        
        this._watchCache();
        
        // Load cached devices
        for (let identity of this._readCache()) {
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
        
        if (this._in !== null) {
            this._in.close();
        }
        
        if (this._listener !== null) {
            this._listener.close();
        }
        
        Notify.uninit();
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

