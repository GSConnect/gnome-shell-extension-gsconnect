#!/usr/bin/env gjs

"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const System = imports.system;

imports.gi.versions.Atspi = "2.0";
imports.gi.versions.Gdk = "3.0";
imports.gi.versions.GdkPixbuf = "2.0";
imports.gi.versions.Gio = "2.0";
imports.gi.versions.GIRepository = "2.0";
imports.gi.versions.GLib = "2.0";
imports.gi.versions.GObject = "2.0";
imports.gi.versions.Gtk = "3.0";
imports.gi.versions.Pango = "1.0";
imports.gi.versions.UPowerGlib = "1.0";

const Gdk = imports.gi.Gdk;
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

window.ext = { datadir: getPath() };

imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Device = imports.service.device;
const Protocol = imports.service.protocol;
const Telephony = imports.service.plugins.telephony;


var DeviceChooser = new Lang.Class({
    Name: "GSConnectDeviceChooser",
    Extends: Gtk.ApplicationWindow,
    Signals: {
        "selected": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },

    _init: function (params) {
        this.parent({
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        this.params = params;

        // HeaderBar
        let headerbar = new Gtk.HeaderBar({
            title: _("Select a Device"),
            subtitle: this.params.title,
            show_close_button: false
        });
        this.set_titlebar(headerbar);

        let cancelButton = new Gtk.Button({ label: _("Cancel") });
        cancelButton.connect("clicked", () => this.destroy());
        headerbar.pack_start(cancelButton);

        let selectButton = new Gtk.Button({
            label: _("Select"),
            sensitive: false
        });
        selectButton.get_style_context().add_class("suggested-action");
        selectButton.connect("clicked", () => {
            this._select(this.list.get_selected_row().device)
        });
        headerbar.pack_end(selectButton);

        // Device List
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect("row-activated", (list, row) => this._select(row.device));
        this.list.connect("selected-rows-changed", () => {
            selectButton.sensitive = (this.list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        this.show_all();
        this._populate();
    },

    _populate: function () {
        for (let device of this.application._devices.values()) {
            if (this.params.filter_func(device)) {
                let row = new Gtk.ListBoxRow();
                row.device = device;
                this.list.add(row);

                let box = new Gtk.Box({
                    margin: 6,
                    spacing: 6
                });
                row.add(box);

                let icon = new Gtk.Image({
                    icon_name: device.type,
                    pixel_size: 32
                });
                box.add(icon);

                let name = new Gtk.Label({
                    label: device.name,
                    halign: Gtk.Align.START,
                    hexpand: true
                });
                box.add(name);

                row.show_all();
            }
        }
    },

    _select: function (device) {
        this.emit("selected", device);
        this.destroy();
    },

    run: function () {
        if (this.list.get_children().length === 1) {
            this._select(this.list.get_children()[0].device);
        } else if (!this.list.get_children().length) {
            this.destroy();
        }
    }
});


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
            application_id: ext.app_id,
            flags: Gio.ApplicationFlags.HANDLES_OPEN
        });

        // This is currently required for clipboard to work under Wayland
        Gdk.set_allowed_backends("x11,*");

        GLib.set_prgname(ext.app_id);
        GLib.set_application_name(_("GSConnect"));

        this.register(null);
    },

    // Properties
    get certificate () {
        return this._certificate;
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
        try {
            let type = Number(
                GLib.file_get_contents("/sys/class/dmi/id/chassis_type")[1]
            );

            if ([8, 9, 10, 14].indexOf(type) > -1) {
                return "laptop";
            }
        } catch (e) {
            debug("Error reading chassis_type: " + e);
        }

        return "desktop";
    },

    /**
     * Special method to accomodate nautilus-gsconnect.py
     */
    getShareable: function () {
        let shareable = [];

        for (let [busPath, device] of this._devices.entries()) {
            if (device.connected && device._plugins.has("share")) {
                shareable.push([busPath, device.name]);
            }
        }

        return shareable;
    },

    /**
     * Generate a Private Key and TLS Certificate
     */
    _initEncryption: function () {
        let certPath = ext.configdir + "/certificate.pem";
        let keyPath = ext.configdir + "/private.pem";

        let hasCertificate = GLib.file_test(certPath, GLib.FileTest.EXISTS);
        let hasPrivateKey = GLib.file_test(keyPath, GLib.FileTest.EXISTS);

        if (!hasPrivateKey || !hasCertificate) {
            let cmd = [
                "openssl", "req", "-new", "-x509", "-sha256", "-newkey",
                "rsa:2048", "-nodes", "-keyout", "private.pem", "-days", "3650",
                "-out", "certificate.pem", "-subj",
                "/CN=" + GLib.uuid_string_random()
            ];

            let proc = GLib.spawn_sync(
                ext.configdir,
                cmd,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
        }

        // Ensure permissions are restrictive
        GLib.spawn_command_line_async("chmod 0600 " + keyPath);
        GLib.spawn_command_line_async("chmod 0600 " + certPath);

        // Load the certificate
        this._certificate = Gio.TlsCertificate.new_from_files(
            certPath,
            keyPath
        );
    },

    _initCSS: function () {
        let provider = new Gtk.CssProvider();
        provider.load_from_file(
            Gio.File.new_for_uri("resource://" + ext.app_path + "/application.css")
        );
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
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
                deviceName: ext.settings.get_string("public-name"),
                deviceType: this.type,
                tcpPort: this.tcpListener._port,
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
        ext.settings.connect("changed::devices", () => {
            //
            for (let id of ext.settings.get_strv("devices")) {
                let dbusPath = ext.app_path + "/Device/" + id.replace(/\W+/g, "_");

                if (!this._devices.has(dbusPath)) {
                    let device = new Device.Device({ id: id})
                    this._devices.set(dbusPath, device);

                    this.notify("devices");
                    this._dbus.emit_property_changed(
                        "devices",
                        new GLib.Variant("as", this.devices)
                    );
                }
            }

            //
            let devices = ext.settings.get_strv("devices");

            for (let [dbusPath, device] of this._devices.entries()) {
                if (devices.indexOf(device.id) < 0) {
                    this._removeDevice(dbusPath);
                }
            }
        });

        ext.settings.emit("changed::devices", "devices");
    },

    _pruneDevices: function () {
        let devices = ext.settings.get_strv("devices");

        for (let device of this._devices.values()) {
            if (!device.connected && !device.paired) {
                devices.splice(devices.indexOf(device.id), 1);
                ext.settings.set_strv("devices", devices);
            }
        }
    },

    _addDevice: function (packet, channel=null) {
        debug("Daemon._addDevice(" + packet.body.deviceName + ")");

        if (!this.identity) { return; }
        if (packet.body.deviceId === this.identity.body.deviceId) { return; }

        let dbusPath = ext.app_path + "/Device/" + packet.body.deviceId.replace(/\W+/g, "_");

        if (this._devices.has(dbusPath)) {
            log("Daemon: Updating device");

            let device = this._devices.get(dbusPath);
            device.update(packet, channel);
        } else {
            log("Daemon: Adding device");

            let device = new Device.Device({
                packet: packet,
                channel: channel
            });
            this._devices.set(dbusPath, device);

            let knownDevices = ext.settings.get_strv("devices");

            if (knownDevices.indexOf(device.id) < 0) {
                knownDevices.push(device.id);
                ext.settings.set_strv("devices", knownDevices);
            }

            this.notify("devices");
            this._dbus.emit_property_changed(
                "devices",
                new GLib.Variant("as", this.devices)
            );
        }
    },

    _removeDevice: function (dbusPath) {
        debug("Daemon._removeDevice(" + dbusPath + ")");

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
        this._ndbus = Gio.DBusExportedObject.wrapJSObject(
            ext.dbusinfo.lookup_interface("org.freedesktop.Notifications"),
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
        debug("Daemon: Notify()");

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
    _getPlugin: function (devicePath, pluginName) {
        let device;

        if ((device = this._devices.get(devicePath))) {
            return device._plugins.get(pluginName);
        }

        return false;
    },

    _batteryWarningAction: function (action, parameter) {
        let dbusPath = parameter.deep_unpack().toString();
        let plugin = this._getPlugin(dbusPath, "findmyphone");

        if (plugin) {
            plugin.find();
        }
    },

    _cancelTransferAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let plugin = this._getPlugin(parameter["0"], "share");

        if (plugin) {
            if (plugin.transfers.has(parameter["1"])) {
                plugin.transfers.get(parameter["1"]).cancel();
            }
        }
    },

    // TODO: check file existence, since the notification will persist while
    //       the file could be moved/deleted
    _openTransferAction: function (action, parameter) {
        let path = parameter.deep_unpack().toString();
        Gio.AppInfo.launch_default_for_uri(unescape(path), null);
    },

    _closeNotificationAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let plugin = this._getPlugin(parameter["0"], "notification");

        if (plugin) {
            plugin.close(unescape(parameter["1"]));
        }
    },

    _muteCallAction: function (action, parameter) {
        let dbusPath = parameter.deep_unpack().toString();
        let plugin = this._getPlugin(dbusPath, "telephony");

        if (plugin) {
            plugin.muteCall();
        }
    },

    _replyMissedCallAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let plugin = this._getPlugin(parameter["0"], "telephony");

        if (plugin) {
            plugin.replyMissedCall(parameter["1"], parameter["2"]);
        }
    },

    _replySmsAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let plugin = this._getPlugin(parameter["0"], "telephony");

        if (plugin) {
            plugin.replySms(parameter["1"], parameter["2"], parameter["3"]);
        }
    },

    _pairAction: function (action, parameter) {
        parameter = parameter.deep_unpack();
        let device;

        if ((device = this._devices.get(parameter["0"]))) {
            if (parameter["1"] === "accept") {
                device.acceptPair();
            } else if (parameter["1"] === "reject") {
                device.rejectPair();
            }
        }
    },

    _restartNautilusAction: function (action, parameter) {
        GLib.spawn_command_line_async("nautilus -q");
    },

    _initNotificationActions: function () {
        let entries = [
            ["pairAction", "(ss)", this._pairAction],
            ["batteryWarning", "s", this._batteryWarningAction],
            ["cancelTransfer", "(ss)", this._cancelTransferAction],
            ["openTransfer", "s", this._openTransferAction],
            ["muteCall", "s", this._muteCallAction],
            ["replyMissedCall", "(sss)", this._replyMissedCallAction],
            ["replySms", "(ssss)", this._replySmsAction],
            ["closeNotification", "(ss)", this._closeNotificationAction],
            ["restartNautilus", "s", this._restartNautilusAction]
        ];

        entries.forEach((entry) => {
            let action = new Gio.SimpleAction({
                name: entry[0],
                parameter_type: new GLib.VariantType(entry[1])
            });
            action.connect("activate", entry[2].bind(this));
            this.add_action(action);
        });
    },

    /**
     *
     */
    notifyNautilusExtension: function () {
        let notif = new Gio.Notification();
        notif.set_title(_("Nautilus extensions changed"));
        notif.set_body(_("Restart Nautilus to apply changes"));
        notif.set_icon(
            new Gio.ThemedIcon({ name: "system-file-manager-symbolic" })
        );
        notif.add_button(
            // TRANSLATORS: Notification button to restart Nautilus
            _("Restart"),
            "app.restartNautilus('null')"
        );

        this.send_notification("nautilus-integration", notif);
    },

    toggleNautilusExtension: function () {
        let path = GLib.get_user_data_dir() + "/nautilus-python/extensions";
        let script = Gio.File.new_for_path(path).get_child("nautilus-gsconnect.py");
        let install = ext.settings.get_boolean("nautilus-integration");

        if (install && !script.query_exists(null)) {
            GLib.mkdir_with_parents(path, 493); // 0755 in octal

            script.make_symbolic_link(
                ext.datadir + "/nautilus-gsconnect.py",
                null
            );

            this.notifyNautilusExtension();
        } else if (!install && script.query_exists(null)) {
            script.delete(null);
            this.notifyNautilusExtension();
        }
    },

    toggleWebExtension: function () {
        let nmhPath = ext.datadir + "/service/nativeMessagingHost.js";

        let google = {
            "name": "org.gnome.shell.extensions.gsconnect",
            "description": "Native messaging host for GSConnect WebExtension",
            "path": nmhPath,
            "type": "stdio",
            "allowed_origins": [ "chrome-extension://jfnifeihccihocjbfcfhicmmgpjicaec/" ]
        };

        let mozilla = {
            "name": "org.gnome.shell.extensions.gsconnect",
            "description": "Native messaging host for GSConnect WebExtension",
            "path": nmhPath,
            "type": "stdio",
            "allowed_extensions": [ "gsconnect@andyholmes.github.io" ]
        };

        let basename = "org.gnome.shell.extensions.gsconnect.json";
        let userConfDir = GLib.get_user_config_dir();
        let browsers = [
            [userConfDir + "/chromium/NativeMessagingHosts/", google],
            [userConfDir + "/google-chrome/NativeMessagingHosts/", google],
            [userConfDir + "/google-chrome-beta/NativeMessagingHosts/", google],
            [userConfDir + "/google-chrome-unstable/NativeMessagingHosts/", google],
            [GLib.get_home_dir() + "/.mozilla/native-messaging-hosts/", mozilla]
        ];

        if (ext.settings.get_boolean("webbrowser-integration")) {
            for (let browser of browsers) {
                GLib.mkdir_with_parents(browser[0], 493);
                GLib.file_set_contents(
                    browser[0] + basename,
                    JSON.stringify(browser[1])
                );
            }

            GLib.spawn_command_line_async("chmod 0755 " + nmhPath);
        } else {
            for (let browser of browsers) {
                GLib.unlink(browser[0] + basename);
            }

            GLib.spawn_command_line_async("chmod 0744 " + nmhPath);
        }
    },

    /**
     * Watch 'daemon.js' in case the extension is uninstalled
     */
    _watchDaemon: function () {
        let daemonFile = Gio.File.new_for_path(
            ext.datadir + "/service/daemon.js"
        );
        this.daemonMonitor = daemonFile.monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this.daemonMonitor.connect("changed", () => this.quit());
    },

    /**
     * GApplication functions
     */
    vfunc_startup: function() {
        this.parent();

        this._devices = new Map();
        this._in = null;
        this._listener = null;

        // Initialize encryption
        try {
            this._initEncryption();
        } catch (e) {
            log("Error generating TLS Certificate: " + e.message);
            this.quit();
        }

        this._initCSS();
        Gtk.IconTheme.get_default().add_resource_path(ext.app_path);

        this._initNotificationListener();
        this._initNotificationActions();
        this._watchDaemon();

        // Export DBus
        let iface = "org.gnome.Shell.Extensions.GSConnect";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            ext.dbusinfo.lookup_interface(iface),
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
            this.quit();
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
            this.quit();
        }

        this.identity = this._getIdentityPacket();
        ext.settings.bind(
            "public-name",
            this,
            "name",
            Gio.SettingsBindFlags.DEFAULT
        );

        // Extensions
        ext.settings.connect("changed::nautilus-integration", () => {
            this.toggleNautilusExtension();
        });
        this.toggleNautilusExtension();

        ext.settings.connect("changed::webbrowser-integration", () => {
            this.toggleWebExtension();
        });
        this.toggleWebExtension();

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

    vfunc_open: function (files, hint) {
        this.parent(files, hint);

        for (let file of files) {
            try {
                if (file.get_uri_scheme() === "sms") {
                    let uri = new Telephony.SmsURI(file.get_uri());

                    let win = new DeviceChooser({
                        title: _("Send SMS"),
                        filter_func: (device) => {
                            return device._plugins.has("telephony");
                        }
                    });

                    win.connect("selected", (window, device) => {
                        device._plugins.get("telephony").openUri(uri);
                    });

                    win.run();
                }
            } catch (e) {
                log("Error opening file/uri: " + e.message);
            }
        }
    },

    vfunc_shutdown: function() {
        this.parent();

        log("GSConnect: Shutting down");

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

