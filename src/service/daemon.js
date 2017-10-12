#!/usr/bin/env gjs

"use strict";

// Imports
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const System = imports.system;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

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
            "LocalFingerprint",
            "SHA1 fingerprint for the local certificate",
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
        
        this.register(null);
    },
    
    // Properties
    get certificate () {
        return Common.getCertificate();
    },
    
    get devices () {
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
        this.udpListener.send(this.identity);
    },
    
    get version () {
        return Common.Me.metadata['version'];
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
     * Identity functions
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
    
    _getIdentityPacket: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: Protocol.TYPE_IDENTITY,
            body: {
                deviceId: "GSConnect@" + GLib.get_host_name(),
                deviceName: this.name,
                deviceType: this._getDeviceType(),
                tcpPort: this.udpListener.socket.local_address.port,
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
     */
    discover: function () {
        this.udpListener.send(this.identity);
    },
    
    /**
     * Device Methods
     */
    _readCache: function () {
        let cacheDir = Gio.File.new_for_path(Common.CONFIG_PATH);
        let fenum = cacheDir.enumerate_children("standard::*", 0, null);
        
        let info;
        let devices = [];
        
        while ((info = fenum.next_file(null))) {
            let deviceDir = fenum.get_child(info);
            let identPath = deviceDir.get_path() + "/identity.json"
            
            try {
                if (GLib.file_test(identPath, GLib.FileTest.EXISTS)) {
                    let [success, data] = GLib.file_get_contents(identPath);
                    let packet = new Protocol.Packet(data.toString());
                    this._addDevice(packet);
                }
            } catch (e) {
                Common.debug("Daemon: Error loading device from cache: " + e);
            }
        }
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
    
    _addDevice: function (packet, channel=null) {
        Common.debug("Daemon._addDevice(" + packet.body.deviceName + ")");
        
        if (packet.body.deviceId === this.identity.body.deviceId) {
            return;
        }
            
        let devObjPath = Common.dbusPathFromId(packet.body.deviceId);
        
        if (this._devices.has(devObjPath)) {
            log("Daemon: Updating device");
            
            let device = this._devices.get(devObjPath);
            device.update(packet, channel);
        } else {
            log("Daemon: Adding device");
            
            let device = new Device.Device(this, packet, channel)
            this._devices.set(devObjPath, device);
            
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
        
        this._writeCache(packet.body.deviceId);
    },
    
    _removeDevice: function (dbusPath) {
        Common.debug("Daemon._removeDevice(" + dbusPath + ")");
        
        if (this._devices.has(dbusPath)) {
            log("Daemon: Removing device");
            
            let device = this._devices.get(dbusPath);
            
            device.destroy();
            this._devices.delete(dbusPath);
        
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
    },
    
    /**
     * Notification listener
     *
     * This has to be a singleton since more than one device might want to
     * receive our notifications, but we only have one Bus to work with.
     */
    _initNotificationListener: function () {
        // org.freedesktop.Notifications interface; needed to catch signals
        let iface = "org.freedesktop.Notifications";
        this._ndbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.freedesktop.lookup_interface(iface),
            this
        );
        this._ndbus.export(Gio.DBus.session, "/org/freedesktop/Notifications");
        
        // Match all notifications
        this._match = new GLib.Variant("(s)", ["interface='org.freedesktop.Notifications',member='Notify',type='method_call',eavesdrop='true'"])
        
        this._proxy = new Gio.DBusProxy({
            gConnection: Gio.DBus.session,
            gName: "org.freedesktop.DBus",
            gObjectPath: "/org/freedesktop/DBus",
            gInterfaceName: "org.freedesktop.DBus"
        });
        
        this._proxy.call_sync("AddMatch", this._match, 0, -1, null);
    },
    
    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        Common.debug("Daemon: Notify()");
        
        for (let device of this._devices.values()) {
            if (device._plugins.has("notifications")) {
                let plugin = device._plugins.get("notifications");
                // TODO: avoid spread operator if possible
                plugin.Notify(...Array.from(arguments));
            }
        }
    },
    
    
    /**
     * App Actions
     */
    _batteryWarningAction: function (action, param) {
        dbusPath = param.deep_unpack().toString();
        
        if (this._devices.has(dbusPath)) {
            let device = this._devices.get(dbusPath);
            
            if (device._plugins.has("findmyphone")) {
                let plugin = device._plugins.get("findmyphone");
                
                plugin.ring();
            }
        }
    },
    
    _cancelTransferAction: function (action, param) {
        param = param.deep_unpack();
        
        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);
            
            if (device._plugins.has("share")) {
                let plugin = device._plugins.get("share");
                
                if (plugin.transfers.has(param["1"])) {
                    plugin.transfers.get(param["1"]).cancel();
                }
            }
        }
    },
    
    // TODO: check it's still a file?
    _openTransferAction: function (action, param) {
        let path = param.deep_unpack().toString();
        
        Gio.AppInfo.launch_default_for_uri(path, null);
    },
    
    _closeNotificationAction: function (action, param) {
        param = param.deep_unpack();
        
        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);
            
            if (device._plugins.has("notifications")) {
                let plugin = device._plugins.get("notifications");
                
                plugin.close(param["1"]);
            }
        }
    },
    
    _muteCallAction: function (action, param) {
        dbusPath = param.deep_unpack().toString();
        
        if (this._devices.has(dbusPath)) {
            let device = this._devices.get(dbusPath);
            
            if (device._plugins.has("telephony")) {
                let plugin = device._plugins.get("telephony");
                
                plugin.muteCall();
            }
        }
    },
    
    _replySmsAction: function (action, param) {
        param = param.deep_unpack();
        
        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);
            
            if (device._plugins.has("telephony")) {
                let plugin = device._plugins.get("telephony");
                
                plugin.replySms(
                    param["1"],
                    param["2"],
                    param["3"],
                    param["4"]
                );
            }
        }
    },
    
    _pairAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let dbusPath = parameter["0"];
        let pairAction = parameter["1"];
        
        if (this._devices.has(dbusPath)) {
            let device = this._devices.get(dbusPath);
            
            if (pairAction === "accept") {
                device.acceptPair();
            } else if (pairAction === "reject") {
                device.rejectPair();
            }
        }
    },
    
    _initActions: function () {
        let pairAction = new Gio.SimpleAction({
            name: "pairAction",
            parameter_type: new GLib.VariantType("(ss)")
        });
        pairAction.connect(
            "activate",
            Lang.bind(this, this._pairAction)
        );
        this.add_action(pairAction);
        
        let batteryWarning = new Gio.SimpleAction({
            name: "batteryWarning",
            parameter_type: new GLib.VariantType("s")
        });
        batteryWarning.connect(
            "activate",
            Lang.bind(this, this._batteryWarningAction)
        );
        this.add_action(batteryWarning);
        
        let cancelTransfer = new Gio.SimpleAction({
            name: "cancelTransfer",
            parameter_type: new GLib.VariantType("(ss)")
        });
        cancelTransfer.connect(
            "activate",
            Lang.bind(this, this._cancelTransferAction)
        );
        this.add_action(cancelTransfer);
        
        let openTransfer = new Gio.SimpleAction({
            name: "openTransfer",
            parameter_type: new GLib.VariantType("s")
        });
        openTransfer.connect(
            "activate",
            Lang.bind(this, this._openTransferAction)
        );
        this.add_action(openTransfer);
        
        let muteCall = new Gio.SimpleAction({
            name: "muteCall",
            parameter_type: new GLib.VariantType("s")
        });
        muteCall.connect(
            "activate",
            Lang.bind(this, this._muteCallAction)
        );
        this.add_action(muteCall);
        
        let replySms = new Gio.SimpleAction({
            name: "replySms",
            parameter_type: new GLib.VariantType("(sssss)")
        });
        replySms.connect(
            "activate",
            Lang.bind(this, this._replySmsAction)
        );
        this.add_action(replySms);
        
        let closeNotification = new Gio.SimpleAction({
            name: "closeNotification",
            parameter_type: new GLib.VariantType("(ss)")
        });
        closeNotification.connect(
            "activate",
            Lang.bind(this, this._closeNotificationAction)
        );
        this.add_action(closeNotification);
    },
    
    /**
     * Watch 'daemon.js' in case the extension is uninstalled
     */
    _watchDaemon: function () {
        let daemonFile = Gio.File.new_for_path(
            Common.Me.path + "/service/daemon.js"
        );
        this.daemonMonitor = daemonFile.monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this.daemonMonitor.connect("changed", (monitor, file, ofile, event) => {
            if (event === 2 || event === 10) {
                this.quit();
            }
        });
    },

    /**
     * GApplication functions
     */
    vfunc_startup: function() {
        this.parent();
        
        this._devices = new Map();
        this._in = null;
        this._listener = null;
        
        // Intitialize configuration and choke hard if it fails
        if (!Common.initConfiguration()) { this.vfunc_shutdown(); }
        
        this._watchDaemon();
        this._initNotificationListener();
        this._initActions();
        
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
        
        // Ensure fingerprint is available right away
        this._dbus.emit_property_changed(
            "fingerprint",
            new GLib.Variant("s", this.fingerprint)
        );
        
        // Listen for new devices
        try {
            this.udpListener = new Protocol.UdpListener();
            this.udpListener.connect("received", (server, packet) => {
                this._addDevice(packet);
            });
        } catch (e) {
            log("Error starting UDP listener: " + e);
            this.vfunc_shutdown();
        }
        
        try {
            this.tcpListener = new Protocol.TcpListener();
            this.tcpListener.connect("incoming", (listener, connection) => {
                let channel = new Protocol.LanChannel(this);
                let conn = channel.connect("connected", (channel) => {
                    GObject.signal_handler_disconnect(channel, conn);
                    this._addDevice(channel.identity, channel);
                });
                channel.accept(connection);
            });
        } catch (e) {
            log("Error starting TCP listener: " + e);
            this.vfunc_shutdown();
        }
        
        this.identity = this._getIdentityPacket();
        
        // Monitor network changes
        this._netmonitor = Gio.NetworkMonitor.get_default();
        this._netmonitor.connect("network-changed", (monitor, available) => {
            if (available) {
                this.discover();
            }
        });
        
        this._watchCache();
        
        // Load cached devices
        this._readCache();
        log(this._devices.size + " devices loaded from cache");
        
        this.discover();
    },

    vfunc_activate: function() {
        this.parent();
        this.hold();
    },

    vfunc_shutdown: function() {
        this.parent();
        
        this.tcpListener.destroy();
        this.udpListener.destroy();
        
        for (let device of this._devices.values()) {
            device.destroy();
        }
        
        this._proxy.call_sync("RemoveMatch", this._match, 0, -1, null);
        this._ndbus.unexport();
        this._dbus.unexport();
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

