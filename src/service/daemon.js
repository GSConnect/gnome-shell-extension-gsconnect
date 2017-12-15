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
        "discovering": GObject.ParamSpec.boolean(
            "discovering",
            "discoveringDevices",
            "Whether the daemon is discovering new devices",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "LocalFingerprint",
            "SHA1 fingerprint for the local certificate",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "DeviceType",
            "The host's device type",
            GObject.ParamFlags.READABLE,
            "desktop"
        )
    },

    _init: function() {
        this.parent({
            application_id: "org.gnome.Shell.Extensions.GSConnect",
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

    get discovering () {
        return this.tcpListener.active;
    },

    set discovering (bool) {
        if (bool) {
            this.tcpListener.start();
            this.broadcast();
        } else {
            this.tcpListener.stop();
            this._pruneDevices();
        }
    },

    get fingerprint () {
        return this.certificate.fingerprint()
    },

    get name() {
        return this.identity.body.deviceName;
    },

    set name(name) {
        this.identity.body.deviceName = name;
        this.notify("name");
        this._dbus.emit_property_changed("name", new GLib.Variant("s", name));
        this.broadcast();
    },

    get type () {
        return this.identity.body.deviceType;
    },

    /**
     * Special method to accomodate nautilus-gsconnect.py
     *
     * TODO: it's ugly!
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
     * Build and return an identity packet for the local device
     */
    _getIdentityPacket: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: Protocol.TYPE_IDENTITY,
            body: {
                deviceId: this.certificate.get_common_name(),
                deviceName: Common.Settings.get_string("public-name"),
                deviceType: Common.getDeviceType(),
                tcpPort: this.udpListener.socket.local_address.port,
                protocolVersion: 7,
                incomingCapabilities: [],
                outgoingCapabilities: []
            }
        });

        for (let name in imports.service.plugins) {
            if (imports.service.plugins[name].METADATA) {
                let metadata = imports.service.plugins[name].METADATA;

                for (let packetType of metadata.incomingPackets) {
                    packet.body.incomingCapabilities.push(packetType);
                }

                for (let packetType of metadata.outgoingPackets) {
                    packet.body.outgoingCapabilities.push(packetType);
                }
            }
        }

        return packet;
    },

    /**
     * Discovery Methods
     */
    broadcast: function () {
        this.udpListener.send(this.identity);
    },

    /**
     * Device Methods
     */
    _watchDevices: function () {
        Common.Settings.connect("changed::devices", () => {
            //
            for (let id of Common.Settings.get_strv("devices")) {
                let dbusPath = Common.dbusPathFromId(id);

                if (!this._devices.has(dbusPath)) {
                    let device = new Device.Device({ daemon: this, id: id})
                    this._devices.set(dbusPath, device);

                    this.notify("devices");
                    this._dbus.emit_property_changed(
                        "devices",
                        new GLib.Variant("as", this.devices)
                    );
                }
            }

            //
            let devices = Common.Settings.get_strv("devices");

            for (let [dbusPath, device] of this._devices.entries()) {
                if (devices.indexOf(device.id) < 0) {
                    this._removeDevice(dbusPath);
                }
            }
        });

        Common.Settings.emit("changed::devices", "devices");
    },

    _pruneDevices: function () {
        let devices = Common.Settings.get_strv("devices");

        for (let device of this._devices.values()) {
            if (!device.connected && !device.paired) {
                devices.splice(devices.indexOf(device.id), 1);
                Common.Settings.set_strv("devices", devices);
            }
        }
    },

    _addDevice: function (packet, channel=null) {
        Common.debug("Daemon._addDevice(" + packet.body.deviceName + ")");

        if (!this.identity) { return; }
        if (packet.body.deviceId === this.identity.body.deviceId) { return; }

        let dbusPath = Common.dbusPathFromId(packet.body.deviceId);

        if (this._devices.has(dbusPath)) {
            log("Daemon: Updating device");

            let device = this._devices.get(dbusPath);
            device.update(packet, channel);
        } else {
            log("Daemon: Adding device");

            let device = new Device.Device({
                daemon: this,
                packet: packet,
                channel: channel
            });
            this._devices.set(dbusPath, device);

            let knownDevices = Common.Settings.get_strv("devices");

            if (knownDevices.indexOf(device.id) < 0) {
                knownDevices.push(device.id);
                Common.Settings.set_strv("devices", knownDevices);
            }

            this.notify("devices");
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
    },

    _removeDevice: function (dbusPath) {
        Common.debug("Daemon._removeDevice(" + dbusPath + ")");

        if (this._devices.has(dbusPath)) {
            log("Daemon: Removing device");

            let device = this._devices.get(dbusPath);

            device.destroy();
            this._devices.delete(dbusPath);

            this.notify("devices");
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
            if (device._plugins.has("notification")) {
                let plugin = device._plugins.get("notification");
                // TODO: avoid spread operator if possible
                plugin.Notify(...Array.from(arguments));
            }
        }
    },

    /**
     * Notification Actions
     */
    _batteryWarningAction: function (action, param) {
        let dbusPath = param.deep_unpack().toString();

        if (this._devices.has(dbusPath)) {
            let device = this._devices.get(dbusPath);

            if (device._plugins.has("findmyphone")) {
                device._plugins.get("findmyphone").find();
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

    // TODO: check file existence, since the notification will persist while
    //       the file could be moved/deleted
    _openTransferAction: function (action, param) {
        let path = param.deep_unpack().toString();
        Gio.AppInfo.launch_default_for_uri(unescape(path), null);
    },

    _closeNotificationAction: function (action, param) {
        param = param.deep_unpack();

        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);

            if (device._plugins.has("notification")) {
                let plugin = device._plugins.get("notification");
                plugin.close(unescape(param["1"]));
            }
        }
    },

    _muteCallAction: function (action, param) {
        let dbusPath = param.deep_unpack().toString();

        if (this._devices.has(dbusPath)) {
            let device = this._devices.get(dbusPath);

            if (device._plugins.has("telephony")) {
                let plugin = device._plugins.get("telephony");
                plugin.muteCall();
            }
        }
    },

    _replyMissedCallAction: function (action, param) {
        param = param.deep_unpack();

        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);

            if (device._plugins.has("telephony")) {
                let plugin = device._plugins.get("telephony");
                plugin.replyMissedCall(param["1"],param["2"]);
            }
        }
    },

    _replySmsAction: function (action, param) {
        param = param.deep_unpack();

        if (this._devices.has(param["0"])) {
            let device = this._devices.get(param["0"]);

            if (device._plugins.has("telephony")) {
                let plugin = device._plugins.get("telephony");
                plugin.replySms(param["1"], param["2"], param["3"]);
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

    _initNotificationActions: function () {
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

        let replyMissedCall = new Gio.SimpleAction({
            name: "replyMissedCall",
            parameter_type: new GLib.VariantType("(sss)")
        });
        replyMissedCall.connect(
            "activate",
            Lang.bind(this, this._replyMissedCallAction)
        );
        this.add_action(replyMissedCall);

        let replySms = new Gio.SimpleAction({
            name: "replySms",
            parameter_type: new GLib.VariantType("(ssss)")
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
            getPath() + "/service/daemon.js"
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
        this._initNotificationActions();

        // Export DBus
        let iface = "org.gnome.Shell.Extensions.GSConnect";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.GSConnect.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/Shell/Extensions/GSConnect"
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
            this.tcpListener.connect("notify::active", () => {
                this._dbus.emit_property_changed(
                    "discovering",
                    new GLib.Variant("b", this.discovering)
                );
            });
            this.tcpListener.stop();
        } catch (e) {
            log("Error starting TCP listener: " + e);
            this.vfunc_shutdown();
        }

        this.identity = this._getIdentityPacket();
        Common.Settings.bind(
            "public-name",
            this,
            "name",
            Gio.SettingsBindFlags.DEFAULT
        );

        Common.Settings.connect("changed::webbrowser-integration", () => {
            if (Common.Settings.get_boolean("webbrowser-integration")) {
                Common.installNativeMessagingHost();
            } else {
                Common.uninstallNativeMessagingHost();
            }
        });
        if (Common.Settings.get_boolean("webbrowser-integration")) {
            Common.installNativeMessagingHost();
        } else {
            Common.uninstallNativeMessagingHost();
        }

        // Monitor network changes
        this._netmonitor = Gio.NetworkMonitor.get_default();
        this._netmonitor.connect("network-changed", (monitor, available) => {
            if (available) {
                this.broadcast();
            }
        });

        // Load cached devices and watch for changes
        this._watchDevices();
        log(this._devices.size + " devices loaded from cache");

        this.broadcast();
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

