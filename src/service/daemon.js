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

window.gsconnect = { datadir: getPath() };
imports.searchPath.push(gsconnect.datadir);

const _bootstrap = imports._bootstrap;
const DBus = imports.modules.dbus;
const Device = imports.service.device;
const Protocol = imports.service.protocol;
const Settings = imports.modules.settings;
const Sound = imports.modules.sound;
const Telephony = imports.service.plugins.telephony;


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
            new GLib.Variant("as", []),
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
            application_id: gsconnect.app_id,
            flags: Gio.ApplicationFlags.HANDLES_OPEN
        });

        GLib.set_prgname(gsconnect.app_id);
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
        return this.lanService.discovering;
    },

    set discovering (bool) {
        this.lanService.discovering = bool;
    },

    get fingerprint () {
        return this.certificate.fingerprint()
    },

    get name() {
        return this.identity.body.deviceName;
    },

    set name(name) {
        this.identity.body.deviceName = name;
        this.notify("name", "s");
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
        let certPath = gsconnect.configdir + "/certificate.pem";
        let certExists = GLib.file_test(certPath, GLib.FileTest.EXISTS);
        let keyPath = gsconnect.configdir + "/private.pem";
        let keyExists = GLib.file_test(keyPath, GLib.FileTest.EXISTS);

        if (!keyExists || !certExists) {
            let cmd = [
                "openssl", "req", "-new", "-x509", "-sha256", "-newkey",
                "rsa:2048", "-nodes", "-keyout", "private.pem", "-days", "3650",
                "-out", "certificate.pem", "-subj",
                "/CN=" + GLib.uuid_string_random()
            ];

            let proc = GLib.spawn_sync(
                gsconnect.configdir,
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
            Gio.File.new_for_uri("resource://" + gsconnect.app_path + "/application.css")
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
                deviceName: gsconnect.settings.get_string("public-name"),
                deviceType: this.type,
                tcpPort: this.lanService.port,
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
        if (this.identity) {
            this.lanService.broadcast(this.identity);
        }
    },

    /**
     * Device Methods
     */
    _watchDevices: function () {
        gsconnect.settings.connect("changed::devices", () => {
            //
            let knownDevices = gsconnect.settings.get_strv("devices");

            // New devices
            for (let id of knownDevices) {
                let dbusPath = gsconnect.app_path + "/Device/" + id.replace(/\W+/g, "_");

                if (!this._devices.has(dbusPath)) {
                    new Promise((resolve, reject) => {
                        let device = new Device.Device({ id: id});
                        // TODO: better
                        device.connect("notify::connected", (device) => {
                            if (!device.connected) {
                                this._pruneDevices();
                            }
                        });
                        this._devices.set(dbusPath, device);
                        resolve(true);
                    }).then((result) => {
                        this.notify("devices", "as");
                    }).catch((e) => {
                        log("GSConnect: Error adding device: " + e);
                    });
                }
            }

            // Old devices
            for (let [dbusPath, device] of this._devices.entries()) {
                if (knownDevices.indexOf(device.id) < 0) {
                    this._removeDevice(dbusPath);
                }
            }
        });

        gsconnect.settings.emit("changed::devices", "devices");
    },

    _pruneDevices: function () {
        if (this._window) {
            return;
        }

        let knownDevices = gsconnect.settings.get_strv("devices");

        for (let device of this._devices.values()) {
            if (!device.connected && !device.paired) {
                knownDevices.splice(knownDevices.indexOf(device.id), 1);
                gsconnect.settings.set_strv("devices", knownDevices);
            }
        }
    },

    _addDevice: function (packet, channel=null) {
        debug(packet);

        return new Promise((resolve, reject) => {
            let dbusPath = gsconnect.app_path + "/Device/" + packet.body.deviceId.replace(/\W+/g, "_");

            if (this._devices.has(dbusPath)) {
                log("GSConnect: Updating device");

                let device = this._devices.get(dbusPath);
                device.update(packet, channel);
                resolve(true);
            } else {
                log("GSConnect: Adding device");

                let device = new Device.Device({
                    packet: packet,
                    channel: channel
                });
                // TODO: better
                device.connect("notify::connected", (device) => {
                    if (!device.connected) {
                        this._pruneDevices();
                    }
                });
                this._devices.set(dbusPath, device);

                let knownDevices = gsconnect.settings.get_strv("devices");

                if (knownDevices.indexOf(device.id) < 0) {
                    knownDevices.push(device.id);
                    gsconnect.settings.set_strv("devices", knownDevices);
                }

                this.notify("devices", "as");
                resolve(true);
            }
        });
    },

    _removeDevice: function (dbusPath) {
        debug("Daemon._removeDevice(" + dbusPath + ")");

        if (this._devices.has(dbusPath)) {
            log("Daemon: Removing device");

            let device = this._devices.get(dbusPath);

            device.destroy();
            this._devices.delete(dbusPath);

            this.notify("devices", "as");
        }
    },

    /**
     * Notification proxy function
     *
     * This function is called by eavesdropping on the Fdo Notifications
     * interface, then forwards the notification to any supporting device.
     */
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
    _cancelTransferAction: function (action, parameter) {
        parameter = parameter.deep_unpack();

        let device = this._devices.get(parameter["0"]);
        let plugin = (device) ? device._plugins.get("share") : false;

        if (plugin) {
            if (plugin.transfers.has(parameter["1"])) {
                plugin.transfers.get(parameter["1"]).cancel();
            }
        }
    },

    /**
     * Only used by plugins/share.js
     */
    _openTransferAction: function (action, parameter) {
        let path = parameter.deep_unpack().toString();
        Gio.AppInfo.launch_default_for_uri(unescape(path), null);
    },

    /**
     * A meta-action for directing device actions.
     *
     * @param {Gio.Action} action - ...
     * @param {Object} params
     * @param {string} params[0] - DBus object path for device
     * @param {string} params[1] - GAction/Method name
     * @param {string} params[2] - JSON string of action data
     */
    _deviceAction: function (action, params) {
        params = params.unpack();
        let device = this._devices.get(params["0"].unpack());
        let name = params["1"].unpack();

        let deviceAction = device.lookup_action(name);

        if (device && deviceAction) {
            try {
                deviceAction.activate(params["2"]);
            } catch (e) {
                debug(e.message + "\n" + e.stack);
            }
        } else {
            debug("Error:\nDevice: " + device + "\nAction: " + name);
        }
    },

    /**
     * Add a list of [name, callback, parameter_type], with callback bound to
     * @scope or 'this'.
     */
    _addActions: function (actions, scope) {
        scope = scope || this;

        actions.map((entry) => {
            let action = new Gio.SimpleAction({
                name: entry[0],
                parameter_type: (entry[2]) ? new GLib.VariantType(entry[2]) : null
            });
            action.connect("activate", entry[1].bind(scope));
            this.add_action(action);
        });
    },

    _initActions: function () {
        this._addActions([
            // Device
            ["deviceAction", this._deviceAction, "(sss)"],
            // Daemon
            ["openSettings", this.openSettings],
            ["cancelTransfer", this._cancelTransferAction, "(ss)"],
            ["openTransfer", this._openTransferAction, "s"],
            ["restartNautilus", this._restartNautilus]
        ]);

        // Mixer actions
        if (Sound._mixerControl) {
            this._mixer = new Sound.Mixer();
            this._addActions([
                ["lowerVolume", this._mixer.lowerVolume],
                ["muteVolume", this._mixer.muteVolume],
                ["muteMicrophone", this._mixer.muteMicrophone],
                ["restoreMixer", this._mixer.restoreMixer]
            ], this._mixer);
        } else {
            this._mixer = null;
        }
    },

    /**
     *
     */
    _restartNautilus: function (action, parameter) {
        GLib.spawn_command_line_async("nautilus -q");
    },

    _notifyRestartNautilus: function () {
        let notif = new Gio.Notification();
        notif.set_title(_("Nautilus extensions changed"));
        notif.set_body(_("Restart Nautilus to apply changes"));
        notif.set_icon(
            new Gio.ThemedIcon({ name: "system-file-manager-symbolic" })
        );
        notif.add_button(
            // TRANSLATORS: Notification button to restart Nautilus
            _("Restart"),
            "app.restartNautilus"
        );

        this.send_notification("nautilus-integration", notif);
    },

    toggleNautilusExtension: function () {
        let path = GLib.get_user_data_dir() + "/nautilus-python/extensions";
        let script = Gio.File.new_for_path(path).get_child("nautilus-gsconnect.py");
        let install = gsconnect.settings.get_boolean("nautilus-integration");

        if (install && !script.query_exists(null)) {
            GLib.mkdir_with_parents(path, 493); // 0755 in octal

            script.make_symbolic_link(
                gsconnect.datadir + "/nautilus-gsconnect.py",
                null
            );

            this._notifyRestartNautilus();
        } else if (!install && script.query_exists(null)) {
            script.delete(null);
            this._notifyRestartNautilus();
        }
    },

    toggleWebExtension: function () {
        let nmhPath = gsconnect.datadir + "/service/nativeMessagingHost.js";

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

        if (gsconnect.settings.get_boolean("webbrowser-integration")) {
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
     * Open the application settings
     */
    openSettings: function (device=null) {
        if (!this._window) {
            this._window = new Settings.SettingsWindow();

            this._window.connect("delete-event", () => {
                delete this._window;
            });
        }

        this._window.present();

        // Select a device page automatically
        if (device) {
            this._window.switcher.foreach((row) => {
                if (row.get_name() === device) {
                    this._window.switcher.select_row(row);
                    return;
                }
            });
        }
    },

    /**
     * Watch 'daemon.js' in case the extension is uninstalled
     * TODO: remove .desktop (etc) on delete
     */
    _watchDaemon: function () {
        let daemonFile = Gio.File.new_for_path(
            gsconnect.datadir + "/service/daemon.js"
        );
        this.daemonMonitor = daemonFile.monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this.daemonMonitor.connect("changed", () => this.quit());
    },

    /**
     * Overrides & utilities
     */
    send_notification: function (notifId, notif) {
        let now = GLib.DateTime.new_now_local().to_unix();

        if (gsconnect.settings.get_int("donotdisturb") <= now) {
            //notif.set_priority(Gio.NotificationPriority.LOW);
            Gtk.Application.prototype.send_notification.call(this, notifId, notif);
        }

        //Gtk.Application.prototype.send_notification.call(this, notifId, notif);
    },

    notify: function (name, format=null) {
        GObject.Object.prototype.notify.call(this, name);

        if (format && this._dbus) {
            this._dbus.emit_property_changed(
                name,
                new GLib.Variant(format, this[name])
            );
        }
    },

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
        Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);

        this._initActions();

        // Watch the file 'daemon.js' to know when we're updated
        this._watchDaemon();

        // Ensure fingerprint is available right away
        this.notify("fingerprint", "s");

        // LanChannelService
        try {
            this.lanService = new Protocol.LanChannelService();

            // UDP
            this.lanService.connect("packet", (service, packet) => {
                if (packet.body.deviceId !== this.identity.body.deviceId) {
                    this._addDevice(packet);
                }
            });

            // TCP
            this.lanService.connect("channel", (service, channel) => {
                this._addDevice(channel.identity, channel);
            });
        } catch (e) {
            log("Error starting LanChannelService: " + e);
            //this.quit();
            throw new Error("error starting lanchannelservice");
        }

        this.identity = this._getIdentityPacket();
        gsconnect.settings.bind(
            "public-name",
            this,
            "name",
            Gio.SettingsBindFlags.DEFAULT
        );

        // Extensions
        gsconnect.settings.connect("changed::nautilus-integration", () => {
            this.toggleNautilusExtension();
        });
        this.toggleNautilusExtension();

        gsconnect.settings.connect("changed::webbrowser-integration", () => {
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
    },

    vfunc_activate: function() {
        this.parent();

        // Load cached devices and watch for changes
        this._watchDevices();
        log(this._devices.size + " devices loaded from cache");

        this.broadcast();

        this.hold();
    },

    vfunc_dbus_register: function (connection, object_path) {
        // Application Interface
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            gsconnect.dbusinfo.lookup_interface(gsconnect.app_id),
            this
        );
        this._dbus.export(connection, gsconnect.app_path);

        // Notifications Listener
        this._fdo = DBus.get_default();
        this._match = "interface='org.freedesktop.Notifications'," +
            "member='Notify'," +
            "type='method_call'," +
            "eavesdrop='true'";
        this._fdo.AddMatch(this._match).then(result => {
            this._ndbus = Gio.DBusExportedObject.wrapJSObject(
                gsconnect.dbusinfo.lookup_interface("org.freedesktop.Notifications"),
                this
            );
            this._ndbus.export(Gio.DBus.session, "/org/freedesktop/Notifications");
        }).catch(e => debug(e.message + "\n" + e.stack));

        return true;
    },

    vfunc_dbus_unregister: function (connection, object_path) {
        this._fdo.RemoveMatch(this._match).then(result => {
            this._ndbus.unexport();
            this._dbus.unexport();

        }).catch(e => debug(e));

        this.parent(connection, object_path);
    },

    vfunc_open: function (files, hint) {
        this.parent(files, hint);

        for (let file of files) {
            try {
                if (file.get_uri_scheme() === "sms") {
                    let uri = new Telephony.SmsURI(file.get_uri());
                    let devices = [];

                    for (let device of this._devices.values()) {
                        if (device._plugins.has("telephony")) {
                            devices.push(device);
                        }
                    }

                    if (devices.length === 1) {
                        devices[0]._plugins.get("telephony").openUri(uri);
                    } else if (devices.length > 1) {
                        let win = new DaemonWidget.DeviceChooser({
                            title: _("Send SMS"),
                            devices: devices
                        });

                        if (win.run() === Gtk.ResponseType.OK) {
                            let device = win.list.get_selected_row().device;
                            device._plugins.get("telephony").openUri(uri);
                        }

                        win.destroy();
                    }
                }
            } catch (e) {
                log("Error opening file/uri: " + e.message);
            }
        }
    },

    vfunc_shutdown: function() {
        this.parent();

        log("GSConnect: Shutting down");

        this.lanService.destroy();

        for (let device of this._devices.values()) {
            device.destroy();
        }
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

