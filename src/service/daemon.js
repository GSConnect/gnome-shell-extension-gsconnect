#!/usr/bin/env gjs

'use strict';

const Gettext = imports.gettext.domain('org.gnome.Shell.Extensions.GSConnect');
const _ = Gettext.gettext;
const System = imports.system;

imports.gi.versions.Atspi = '2.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GdkPixbuf = '2.0';
imports.gi.versions.Gio = '2.0';
imports.gi.versions.GIRepository = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Pango = '1.0';
imports.gi.versions.UPowerGlib = '1.0';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Bootstrap
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp('@(.+):\\d+').exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

window.gsconnect = { datadir: getPath() };
imports.searchPath.unshift(gsconnect.datadir);
imports._gsconnect;

// Local Imports
const Bluetooth = imports.service.bluetooth;
const Core = imports.service.core;
const DBus = imports.modules.dbus;
const Device = imports.service.device;
const Lan = imports.service.lan;
const Settings = imports.service.settings;
const Sms = imports.modules.sms;
const Sound = imports.modules.sound;


var Daemon = GObject.registerClass({
    GTypeName: 'GSConnectDaemon',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'TlsCertificate',
            'The local TLS Certificate',
            GObject.ParamFlags.READABLE,
            Gio.TlsCertificate
        ),
        'devices': GObject.param_spec_variant(
            'devices',
            'DevicesList',
            'A list of known devices',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'discovering': GObject.ParamSpec.boolean(
            'discovering',
            'discoveringDevices',
            'Whether the daemon is discovering new devices',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'fingerprint': GObject.ParamSpec.string(
            'fingerprint',
            'LocalFingerprint',
            'SHA1 fingerprint for the local certificate',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'DeviceName',
            'The name announced to the network',
            GObject.ParamFlags.READWRITE,
            'GSConnect'
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'DeviceType',
            'The service device type',
            GObject.ParamFlags.READABLE,
            'desktop'
        )
    }
}, class Daemon extends Gtk.Application {

    _init() {
        super._init({
            application_id: gsconnect.app_id,
            flags: Gio.ApplicationFlags.HANDLES_OPEN
        });

        // This is currently required for clipboard to work under Wayland, but
        // in future will probably just be removed.
        Gdk.set_allowed_backends('x11,*');

        GLib.set_prgname(gsconnect.app_id);
        GLib.set_application_name(_('GSConnect'));

        this.register(null);
    }

    // Properties
    get certificate() {
        // https://github.com/KDE/kdeconnect-kde/blob/master/core/kdeconnectconfig.cpp#L119
        if (this._certificate === undefined) {
            let certPath = gsconnect.configdir + '/certificate.pem';
            let certExists = GLib.file_test(certPath, GLib.FileTest.EXISTS);
            let keyPath = gsconnect.configdir + '/private.pem';
            let keyExists = GLib.file_test(keyPath, GLib.FileTest.EXISTS);

            if (!keyExists || !certExists) {
                let cmd = [
                    'openssl', 'req', '-new', '-x509', '-sha256',
                    '-newkey', 'rsa:2048', '-nodes', '-keyout', 'private.pem',
                    '-days', '3650', '-out', 'certificate.pem', '-subj',
                    '/O=andyholmes.github.io/OU=GSConnect/CN=' + GLib.uuid_string_random()
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
            GLib.spawn_command_line_async(`chmod 0600 ${keyPath}`);
            GLib.spawn_command_line_async(`chmod 0600 ${certPath}`);

            // Load the certificate
            this._certificate = Gio.TlsCertificate.new_from_files(certPath, keyPath);
            this.notify('fingerprint');
        }

        return this._certificate;
    }

    get devices() {
        return this.objectManager.get_objects().map(obj => obj.g_object_path);
    }

    // FIXME: implement bluetooth discovery
    get discovering() {
        return this.lanService.discovering;
    }

    set discovering(bool) {
        this.lanService.discovering = bool;
    }

    get fingerprint() {
        return this.certificate.fingerprint();
    }

    get identity() {
        if (this._identity === undefined) {
            this._identity = new Core.Packet({
                id: 0,
                type: 'kdeconnect.identity',
                body: {
                    deviceId: this.certificate.common_name,
                    deviceName: gsconnect.settings.get_string('public-name'),
                    deviceType: this.type,
                    tcpPort: this.lanService.port,
                    protocolVersion: 7,
                    incomingCapabilities: [],
                    outgoingCapabilities: []
                }
            });

            for (let name in imports.service.plugins) {
                let meta = imports.service.plugins[name].Metadata;

                if (!meta) continue;

                for (let packetType of meta.incomingCapabilities) {
                    this._identity.body.incomingCapabilities.push(packetType);
                }

                for (let packetType of meta.outgoingCapabilities) {
                    this._identity.body.outgoingCapabilities.push(packetType);
                }
            }
        }

        return this._identity;
    }

    get name() {
        return this.identity.body.deviceName;
    }

    set name(name) {
        this.identity.body.deviceName = name;
        this.notify('name');
        this.broadcast();
    }

    get type() {
        if (this._type === undefined) {
            try {
                let type = Number(
                    GLib.file_get_contents('/sys/class/dmi/id/chassis_type')[1]
                );

                this._type = ([8, 9, 10, 14].indexOf(type) > -1) ? 'laptop' : 'desktop';
            } catch (e) {
                this._type = 'desktop';
            }
        }

        return this._type;
    }

    /**
     * Special method to accomodate nautilus-gsconnect.py
     */
    getShareable() {
        let shareable = [];

        for (let [busPath, device] of this._devices.entries()) {
            let action = device.lookup_action('shareFile');

            if (action && action.enabled) {
                shareable.push([busPath, device.name]);
            }
        }

        return shareable;
    }

    _applyResources() {
        let provider = new Gtk.CssProvider();
        provider.load_from_file(
            Gio.File.new_for_uri('resource://' + gsconnect.app_path + '/application.css')
        );
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    /**
     * Discovery Methods
     */
    broadcast() {
        if (this.identity) {
            this.lanService.broadcast(this.identity);
        }
    }

    /**
     * Device Methods
     */
    _addDevice(packet, channel=null) {
        debug(packet);

        let dbusPath = `${gsconnect.app_path}/Device/${packet.body.deviceId.replace(/\W+/g, '_')}`;

        if (this._devices.has(dbusPath)) {
            log(`GSConnect: Updating ${packet.body.deviceName}`);

            this._devices.get(dbusPath).update(packet, channel);
        } else {
            log(`GSConnect: Adding ${packet.body.deviceName}`);

            return new Promise((resolve, reject) => {
                resolve(new Device.Device(packet));
            }).then(device => {
                // TODO: better
                device.connect('notify::connected', (device) => {
                    if (!device.connected) { this._pruneDevices(); }
                });
                this._devices.set(dbusPath, device);
                this.notify('devices');

                device.update(packet, channel);

                let knownDevices = gsconnect.settings.get_strv('devices');

                if (knownDevices.indexOf(device.id) < 0) {
                    knownDevices.push(device.id);
                    gsconnect.settings.set_strv('devices', knownDevices);
                }
            }).catch(debug);
        }
    }

    _removeDevice(dbusPath) {
        debug(dbusPath);

        let device = this._devices.get(dbusPath);

        if (device) {
            log(`GSConnect: Removing ${device.name}`);

            device.destroy();
            this._devices.delete(dbusPath);
            this.notify('devices');
        }
    }

    _onDevicesChanged() {
        let knownDevices = gsconnect.settings.get_strv('devices');

        // New devices
        let newDevices = knownDevices.map(id => {
            let dbusPath = `${gsconnect.app_path}/Device/${id.replace(/\W+/g, '_')}`;

            if (!this._devices.has(dbusPath)) {
                return this._addDevice({ body: { deviceId: id } });
            }
        });

        // Old devices
        Promise.all(newDevices).then(result => {
            for (let [dbusPath, device] of this._devices.entries()) {
                if (knownDevices.indexOf(device.id) < 0) {
                    this._removeDevice(dbusPath);
                }
            }
        }).catch(debug);
    }

    _pruneDevices() {
        // Don't prune devices while the settings window is open
        if (this._window && this._window.visible) {
            return;
        }

        let knownDevices = gsconnect.settings.get_strv('devices');

        for (let device of this._devices.values()) {
            if (!device.connected && !device.paired) {
                knownDevices.splice(knownDevices.indexOf(device.id), 1);
                gsconnect.settings.set_strv('devices', knownDevices);
            }
        }
    }

    _watchDevices() {
        this._devices = new Map();

        gsconnect.settings.connect('changed::devices', () => {
            this._onDevicesChanged();
        });

        this._onDevicesChanged();
        log(`${this._devices.size} devices loaded from cache`);
    }

    /**
     * Local Notifications
     *
     * There are two buses we watch for notifications:
     *   1) org.freedesktop.Notifications (libnotify)
     *   2) org.gtk.Notifications (GNotification)
     */
    _getAppNotificationSettings() {
        this._appNotificationSettings = {};

        for (let app of this._desktopNotificationSettings.get_strv('application-children')) {
            let appSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications.application',
                path: '/org/gnome/desktop/notifications/application/' + app + '/'
            });

            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string('application-id')
            );

            if (appInfo) {
                this._appNotificationSettings[appInfo.get_display_name()] = appSettings;
            }
        }
    }

    _startNotificationListener() {
        // Respect desktop notification settings
        this._desktopNotificationSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications'
        });
        this._desktopNotificationSettings.connect(
            'changed::application-children',
            this._getAppNotificationSettings.bind(this)
        );
        this._getAppNotificationSettings();

        // Special connection for monitoring
        this._dbusMonitor = Gio.DBusConnection.new_for_address_sync(
            Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null),
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT,
            null,
            null
        );

        // Introduce the connection to DBus
        this._dbusMonitor.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "Hello",
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        // libnotify (org.freedesktop.Notifications)
        this._fdoNotifications = new DBus.Interface({
            g_connection: this._dbusMonitor,
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(
                'org.freedesktop.Notifications'
            ),
            g_object_path: '/org/freedesktop/Notifications'
        });

        let fdoMatch = 'interface=\'org.freedesktop.Notifications\',' +
                       'member=\'Notify\',' +
                       'type=\'method_call\'';

        // GNotification (org.gtk.Notifications)
        this._gtkNotifications = new DBus.Interface({
            g_connection: this._dbusMonitor,
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(
                'org.gtk.Notifications'
            ),
            g_object_path: '/org/gtk/Notifications'
        });

        let gtkMatch = 'interface=\'org.gtk.Notifications\',' +
                       'member=\'AddNotification\',' +
                       'type=\'method_call\'';

        // Become a monitor for Fdo & Gtk notifications
        this._dbusMonitor.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.Monitoring",
            "BecomeMonitor",
            new GLib.Variant("(asu)", [[fdoMatch, gtkMatch], 0]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
    }

    _stopNotificationListener() {
        this._fdoNotifications.destroy();
        this._gtkNotifications.destroy();
        this._dbusMonitor.close_sync(null);
    }

    _sendNotification(notif) {
        debug(notif);

        // Check if notifications are disabled in desktop settings
        let appSettings = this._appNotificationSettings[notif.appName];

        if (appSettings && !appSettings.get_boolean('enable')) {
            return;
        }

        // Send the notification to each supporting device
        let variant = gsconnect.full_pack(notif);

        for (let device of this._devices.values()) {
            device.activate_action('sendNotification', variant);
        }
    }

    Notify(appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        // Ignore notifications without an appName
        if (!appName) {
            return;
        }

        this._sendNotification({
            appName: appName,
            id: replacesId,
            title: summary,
            text: body,
            ticker: `${summary}: ${body}`,
            isClearable: (replacesId !== '0'),
            icon: iconName
        });
    }

    AddNotification(application, id, notification) {
        // Ignore our own notifications (otherwise things could get loopy)
        if (application === 'org.gnome.Shell.Extensions.GSConnect') {
            return;
        }

        let appInfo = Gio.DesktopAppInfo.new(`${application}.desktop`);

        // Try to get an icon for the notification
        let icon = null;

        if (notification.hasOwnProperty('icon')) {
            icon = notification.icon;
        // Fallback to GAppInfo icon
        } else {
            icon = appInfo.get_icon().to_string();
        }

        this._sendNotification({
            appName: appInfo.get_display_name(),
            id: id,
            title: notification.title,
            text: notification.body,
            ticker: `${notification.title}: ${notification.body}`,
            isClearable: true,
            icon: icon
        });
    }

    /**
     * Only used by plugins/share.js
     */
    _cancelTransferAction(action, parameter) {
        parameter = parameter.deep_unpack();

        let device = this._devices.get(parameter['0']);
        let plugin = (device) ? device._plugins.get('share') : false;

        if (plugin) {
            if (plugin.transfers.has(parameter['1'])) {
                plugin.transfers.get(parameter['1']).cancel();
            }
        }
    }

    _openTransferAction(action, parameter) {
        let path = parameter.deep_unpack().toString();
        Gio.AppInfo.launch_default_for_uri(unescape(path), null);
    }

    // TODO: it would be nice to populate this entirely from metadata.json, and
    //       in turn populate that during meson.build
    _aboutAction() {
        let dialog = new Gtk.AboutDialog({
            application: this,
            authors: [
                'Andy Holmes <andrew.g.r.holmes@gmail.com>',
                'Bertrand Lacoste <getzze@gmail.com>',
                'Peter Oliver'
            ],
            comments: gsconnect.metadata.description,
            logo: GdkPixbuf.Pixbuf.new_from_resource_at_scale(
                gsconnect.app_path + '/icons/' + gsconnect.app_id + '.svg',
                128,
                128,
                true
            ),
            program_name: _('GSConnect'),
            version: gsconnect.metadata.version,
            website: gsconnect.metadata.url,
            license_type: Gtk.License.GPL_2_0
        });
        dialog.connect('delete-event', dialog => dialog.destroy());
        dialog.show();
    }

    /**
     * A meta-action for routing device actions.
     *
     * @param {Gio.Action} action - ...
     * @param {GLib.Variant(av)} parameter - ...
     * @param {GLib.Variant(o)} parameter[0] - Object path of the device
     * @param {GLib.Variant(s)} parameter[1] - GAction name
     * @param {GLib.Variant(b)} parameter[2] - %false if the parameter is null
     * @param {GLib.Variant(v)} parameter[3] - GAction parameter
     */
    _deviceAction(action, parameter) {
        parameter = parameter.unpack();

        let device = this._devices.get(parameter[0].unpack());

        // If the device is available
        if (device) {
            device.activate_action(
                parameter[1].unpack(),
                parameter[2].unpack() ? parameter[3].unpack() : null
            );
        }
    }

    /**
     * Add a list of [name, callback, parameter_type], with callback bound to
     * @scope or 'this'.
     */
    _addActions(actions, context) {
        context = context || this;

        actions.map((entry) => {
            let action = new Gio.SimpleAction({
                name: entry[0],
                parameter_type: (entry[2]) ? new GLib.VariantType(entry[2]) : null
            });
            action.connect('activate', entry[1].bind(context));
            this.add_action(action);
        });
    }

    _initActions() {
        this._addActions([
            // Device
            ['deviceAction', this._deviceAction, '(osv)'],
            // Daemon
            ['openSettings', this.openSettings],
            ['cancelTransfer', this._cancelTransferAction, '(ss)'],
            ['openTransfer', this._openTransferAction, 's'],
            ['about', this._aboutAction]
        ]);

        // Mixer actions
        if (Sound._mixerControl) {
            this._mixer = new Sound.Mixer();
            this._addActions([
                ['lowerVolume', this._mixer.lowerVolume],
                ['muteVolume', this._mixer.muteVolume],
                ['muteMicrophone', this._mixer.muteMicrophone],
                ['restoreMixer', this._mixer.restoreMixer]
            ], this._mixer);
        } else {
            this._mixer = null;
        }
    }

    /**
     * Open the application settings, for @device if given.
     * @param {String} [device] - DBus object path of the device
     *
     * The DBus method takes no arguments; Device.openSettings() calls this and
     * populates @device.
     */
    openSettings(device=null) {
        if (!this._window) {
            this._window = new Settings.Window({ application: this });
            this._window.connect('delete-event', (window) => {
                window.visible = false;
                this._pruneDevices();
                System.gc();

                return true;
            });
        }

        this._window.present();

        // Open to a device page
        if (device) {
            this._window.switcher.foreach(row => {
                if (row.get_name() === device) {
                    this._window.switcher.select_row(row);
                    return;
                }
            });
        // Open the main page
        } else {
            this._window._onPrevious();
        }
    }

    /**
     * Watch 'daemon.js' in case the extension is uninstalled
     * TODO: remove .desktop (etc) on delete
     */
    _watchDaemon() {
        this.daemonMonitor = Gio.File.new_for_path(
            gsconnect.datadir + '/service/daemon.js'
        ).monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );

        this.daemonMonitor.connect('changed', () => this.quit());
    }

    /**
     * Override Gio.Application.send_notification() to respect donotdisturb
     */
    send_notification(id, notification) {
        if (!this._notificationSettings) {
            this._notificationSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications.application',
                path: '/org/gnome/desktop/notifications/application/org-gnome-shell-extensions-gsconnect/'
            });
        }

        let now = GLib.DateTime.new_now_local().to_unix();
        let dnd = (gsconnect.settings.get_int('donotdisturb') <= now);

        // Maybe the 'enable-sound-alerts' should be left alone/queried
        this._notificationSettings.set_boolean('enable-sound-alerts', dnd);
        this._notificationSettings.set_boolean('show-banners', dnd);

        Gtk.Application.prototype.send_notification.call(this, id, notification);
    }

    vfunc_startup() {
        super.vfunc_startup();

        // Watch the file 'daemon.js' to know when we're updated
        this._watchDaemon();

        // Init some resources
        this._applyResources();

        // GActions
        this._initActions();

        // LanChannelService
        try {
            this.lanService = new Lan.ChannelService();

            // TCP
            this.lanService.connect('channel', (service, channel) => {
                this._addDevice(channel.identity, channel);
            });

            // UDP
            this.lanService.connect('packet', (service, packet) => {
                // Ignore our broadcasts
                if (packet.body.deviceId !== this.identity.body.deviceId) {
                    this._addDevice(packet);
                }
            });
        } catch (e) {
            debug(e);
        }

        // BluetoothChannelService
        try {
            this.bluetoothService = new Bluetooth.ChannelService();

            this.bluetoothService.connect('channel', (service, channel) => {
                this._addDevice(channel.identity, channel);
            });
        } catch (e) {
            debug(e);
        }

        gsconnect.settings.bind(
            'public-name',
            this,
            'name',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Monitor network changes
        this._netmonitor = Gio.NetworkMonitor.get_default();
        this._netmonitor.connect('network-changed', (monitor, available) => {
            if (available) {
                this.broadcast();
            }
        });

        // Track devices, DBus object path as key
        // FIXME: there's now some overlap with use of ObjectManager here...
        this._watchDevices();
    }

    vfunc_activate() {
        super.vfunc_activate();
        // FIXME: this.broadcast();
        this.hold();
    }

    vfunc_dbus_register(connection, object_path) {
        if (!super.vfunc_dbus_register(connection, object_path)) {
            return false;
        }

        // org.freedesktop.ObjectManager interface; only devices currently
        this.objectManager = new Gio.DBusObjectManagerServer({
            connection: connection,
            object_path: object_path
        });

        // org.gnome.Shell.Extensions.GSConnect interface
        this._dbus = new DBus.Interface({
            g_connection: connection,
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(gsconnect.app_id),
            g_object_path: gsconnect.app_path
        });

        // Start the notification listeners
        this._startNotificationListener();

        return true;
    }

    vfunc_dbus_unregister(connection, object_path) {
        // Stop the notification listeners
        this._stopNotificationListener();

        // Must be done before g_name_owner === null
        for (let device of this._devices.values()) {
            device.destroy();
        }

        this._dbus.destroy();

        super.vfunc_dbus_unregister(connection, object_path);
    }

    // FIXME: this is all garbage
    vfunc_open(files, hint) {
        super.vfunc_open(files, hint);

        for (let file of files) {
            let devices = [];
            let action, parameter, title;

            try {
                if (file.get_uri_scheme() === 'sms') {
                    title = _('Send SMS');
                    action = 'uriSms';
                    parameter = new GLib.Variant('s', file.get_uri());
                } else if (file.get_uri_scheme() === 'tel') {
                    title = _('Dial Number');
                    action = 'shareUrl';
                    parameter = new GLib.Variant('s', file.get_uri());
                } else {
                    throw new Error('Unsupported file type');
                }

                for (let device of this._devices.values()) {
                    if (device.get_action_enabled(action)) {
                        devices.push(device);
                    }
                }

                if (devices.length === 1) {
                    devices[0].activate_action(action, parameter);
                } else if (devices.length > 1) {
                    let win = new Settings.DeviceChooser({
                        title: title,
                        devices: devices
                    });

                    if (win.run() === Gtk.ResponseType.OK) {
                        win.get_device().activate_action(action, parameter);
                    }

                    win.destroy();
                }
            } catch (e) {
                logError(e);
            }
        }
    }

    vfunc_shutdown() {
        super.vfunc_shutdown();

        log('GSConnect: Shutting down');

        this.lanService.destroy();
        this.bluetoothService.destroy();
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

