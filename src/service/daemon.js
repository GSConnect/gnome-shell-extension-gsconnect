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

window.gsconnect = { extdatadir: getPath() };
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const Bluetooth = imports.service.bluetooth;
const Core = imports.service.core;
const Device = imports.service.device;
const Lan = imports.service.lan;
const Notification = imports.modules.notification;
const Sound = imports.modules.sound;

const ServiceUI = imports.service.ui.service;
const Settings = imports.service.ui.settings;


var Daemon = GObject.registerClass({
    GTypeName: 'GSConnectDaemon',
    Properties: {
        'devices': GObject.param_spec_variant(
            'devices',
            'DevicesList',
            'A list of known devices',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'discoverable': GObject.ParamSpec.boolean(
            'discoverable',
            'Discoverable',
            'Whether the service responds to discovery requests',
            GObject.ParamFlags.READWRITE,
            false
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
                let proc = new Gio.Subprocess({
                    argv: [
                        'openssl', 'req',
                        '-new', '-x509', '-sha256',
                        '-out', certPath,
                        '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', keyPath,
                        '-days', '3650',
                        '-subj', '/O=andyholmes.github.io/OU=GSConnect/CN=' + GLib.uuid_string_random()
                    ],
                    flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
                });
                proc.init(null);
                proc.wait_check(null);
            }

            // Load the certificate
            this._certificate = Gio.TlsCertificate.new_from_files(certPath, keyPath);
        }

        return this._certificate;
    }

    get devices() {
        return Array.from(this._devices.keys())
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

                meta.incomingCapabilities.map(type => {
                    this._identity.body.incomingCapabilities.push(type);
                });

                meta.outgoingCapabilities.map(type => {
                    this._identity.body.outgoingCapabilities.push(type);
                });
            }
        }

        return this._identity;
    }

    get type() {
        if (this._type === undefined) {
            try {
                let type = Number(
                    GLib.file_get_contents('/sys/class/dmi/id/chassis_type')[1]
                );

                this._type = ([8, 9, 10, 14].includes(type)) ? 'laptop' : 'desktop';
            } catch (e) {
                this._type = 'desktop';
            }
        }

        return this._type;
    }

    /**
     * Discovery Methods
     */
    broadcast(address=null) {
        switch (true) {
            case (address instanceof Gio.InetSocketAddress):
                this.lanService.broadcast(address);
                break;

            case (typeof address === 'string'):
                this.bluetoothService.broadcast(address);
                break;

            default:
                this.lanService.broadcast();
                this.bluetoothService.broadcast();
        }
    }

    /**
     * Return a device for @packet, creating it and adding it to the list of
     * of known devices if it doesn't exist.
     *
     * @param {kdeconnect.identity} packet - An identity packet for the device
     * @return {Device.Device} - A device object
     */
    _ensureDevice(packet) {
        let device = this._devices.get(packet.body.deviceId);

        if (device === undefined) {
            log(`GSConnect: Adding ${packet.body.deviceName}`);

            device = new Device.Device(packet);

            // TODO :(
            device._pruneId = device.connect(
                'notify::connected',
                this._pruneDevices.bind(this)
            );

            this._devices.set(device.id, device);
            this.notify('devices');

            let cached = gsconnect.settings.get_strv('devices');

            if (!cached.includes(device.id)) {
                cached.push(device.id);
                gsconnect.settings.set_strv('devices', cached);
            }
        }

        return device;
    }

    async _removeDevice(id) {
        let device = this._devices.get(id);

        if (device) {
            log(`GSConnect: Removing ${device.name}`);

            device.destroy();
            this._devices.delete(id);
            this.notify('devices');
        }

        return id;
    }

    async _pruneDevices() {
        // Don't prune devices while the settings window is open
        if (this._window && this._window.visible) {
            return;
        }

        let cached = gsconnect.settings.get_strv('devices');

        for (let device of this._devices.values()) {
            if (!device.connected && !device.paired && cached.includes(device.id)) {
                device.disconnect(device._pruneId);
                let id = await this._removeDevice(device.id);
                cached.splice(cached.indexOf(id), 1);
                gsconnect.settings.set_strv('devices', cached);
            }
        }
    }

    /**
     * Delete a known device.
     *
     * This will remove the device from the cache of known devices, then unpair,
     * disconnect and delete all GSettings and cached files.
     *
     * @param {String} id - The id of the device to delete
     */
    deleteDevice(id) {
        let device = this._devices.get(id);

        if (device) {
            // Remove from the list of known devices
            let cached = gsconnect.settings.get_strv('devices');

            if (cached.includes(id)) {
                cached.splice(cached.indexOf(id), 1);
                gsconnect.settings.set_strv('devices', cached);
            }

            // Stash the settings path before unpairing and removing
            let settings_path = device.settings.path;
            device.unpair();
            this._removeDevice(id);

            // Delete all GSettings
            GLib.spawn_command_line_async(`dconf reset -f ${settings_path}`);

            // Delete the cache
            let cache = GLib.build_filenamev([gsconnect.cachedir, id]);
            GLib.spawn_command_line_async(`rm -rf ${cache}`);
        }
    }

    _connectDeviceAction() {
        (new ServiceUI.DeviceConnectDialog()).show_all();
    }

    _aboutAction() {
        if (this._about === undefined) {
            this._about = new Gtk.AboutDialog({
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
                // TRANSLATORS: eg. 'Translator Name <your.email@domain.com>'
                translator_credits: _('translator-credits'),
                version: gsconnect.metadata.version,
                website: gsconnect.metadata.url,
                license_type: Gtk.License.GPL_2_0
            });
            this._about.connect('delete-event', dialog => dialog.hide_on_delete());
        }

        this._about.modal = (this._window && this._window.visible);
        this._about.transient_for = this._about.modal ? this._window : null;
        this._about.present();
    }

    /**
     * A meta-action for routing device actions.
     *
     * @param {Gio.Action} action - ...
     * @param {GLib.Variant(av)} parameter - ...
     * @param {GLib.Variant(s)} parameter[0] - Device Id
     * @param {GLib.Variant(s)} parameter[1] - GAction name
     * @param {GLib.Variant(b)} parameter[2] - %false if the parameter is null
     * @param {GLib.Variant(v)} parameter[3] - GAction parameter
     */
    _deviceAction(action, parameter) {
        parameter = parameter.unpack();

        let id = parameter[0].unpack();
        let devices = (id === '*') ? this._devices.values() : [this._devices.get(id)];

        for (let device of devices) {
            // If the device is available
            if (device) {
                device.activate_action(
                    parameter[1].unpack(),
                    parameter[2].unpack() ? parameter[3].unpack() : null
                );
            }
        }
    }

    /**
     * Service GActions
     */
    _initActions() {
        let actions = [
            // Device
            ['deviceAction', this._deviceAction.bind(this), '(ssbv)'],
            // Daemon
            ['connectDevice', this._connectDeviceAction.bind(this)],
            ['broadcast', this.broadcast.bind(this)],
            ['openSettings', this.openSettings.bind(this)],
            ['quit', this.quit.bind(this)],
            ['debugger', this._debugger.bind(this)],
            ['about', this._aboutAction.bind(this)]
        ];

        actions.map(entry => {
            let action = new Gio.SimpleAction({
                name: entry[0],
                parameter_type: (entry[2]) ? new GLib.VariantType(entry[2]) : null
            });
            action.connect('activate', entry[1]);
            this.add_action(action);
        });

        this.add_action(
            new Gio.PropertyAction({
                name: 'discoverable',
                object: this,
                property_name: 'discoverable'
            })
        );
    }

    _debugger() {
        (new imports.modules.debug.Window()).present();
    }

    /**
     * Open the application settings, for @device if given.
     * @param {String} [device] - Device id
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

        // TODO: Maybe the 'enable-sound-alerts' should be left alone/queried
        this._notificationSettings.set_boolean('enable-sound-alerts', dnd);
        this._notificationSettings.set_boolean('show-banners', dnd);

        super.send_notification(id, notification);
    }

    /**
     * Remove a local libnotify or Gtk notification.
     *
     * @param {String|Number} id - Gtk (string) or libnotify id (uint32)
     * @param {String|null} application - Application Id if Gtk or null
     */
    async remove_notification(id, application=null) {
        let name, path, method, variant;

        if (application !== null) {
            name = 'org.gtk.Notifications';
            method = 'RemoveNotification';
            path = '/org/gtk/Notifications';
            variant = new GLib.Variant('(ss)', [application, id]);
        } else {
            name = 'org.freedesktop.Notifications';
            path = '/org/freedesktop/Notifications';
            method = 'CloseNotification';
            variant = new GLib.Variant('(u)', [id]);
        }

        Gio.DBus.session.call(
            name, path, name, method, variant, null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, res) => {
            try {
                connection.call_finish(res);
            } catch (e) {
                logError(e);
            }
        });
    }

    vfunc_activate() {
        this.broadcast();
    }

    vfunc_startup() {
        super.vfunc_startup();

        this.hold();

        // Watch *this* file and stop the daemon if it's changed/removed
        this._daemonMonitor = Gio.File.new_for_path(
            gsconnect.extdatadir + '/service/daemon.js'
        ).monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this._daemonMonitor.connect('changed', () => this.quit());

        // Properties
        gsconnect.settings.bind(
            'discoverable',
            this,
            'discoverable',
            Gio.SettingsBindFlags.DEFAULT
        );

        gsconnect.settings.bind(
            'public-name',
            this,
            'name',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Keep identity updated and broadcast any name changes
        gsconnect.settings.connect('changed::public-name', (settings) => {
            this.identity.body.deviceName = this.name;
            this.broadcast();
        });

        // Init some resources
        let provider = new Gtk.CssProvider();
        provider.load_from_resource(gsconnect.app_path + '/application.css');
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // Track devices with id as key
        this._devices = new Map();

        // Load cached devices
        let cached = gsconnect.settings.get_strv('devices');
        log(`Loading ${cached.length} device(s) from cache`);
        cached.map(id => this._ensureDevice({
            body: {
                deviceId: id,
                deviceName: 'cached device'
            }
        }));

        // Lan.ChannelService
        try {
            this.lanService = new Lan.ChannelService();
        } catch (e) {
            logError(e, 'Lan.ChannelService');
        }

        // Bluetooth.ChannelService
        try {
            this.bluetoothService = new Bluetooth.ChannelService();
        } catch (e) {
            logError(e, 'Bluetooth.ChannelService');
        }

        // GActions
        this._initActions();

        // Notification Listener
        this.notificationListener = new Notification.Listener();
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

        return true;
    }

    vfunc_dbus_unregister(connection, object_path) {
        // Must be done before g_name_owner === null
        for (let device of this._devices.values()) {
            device.destroy();
        }

        super.vfunc_dbus_unregister(connection, object_path);
    }

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
                    throw new Error('Unsupported file/URI type');
                }

                for (let device of this._devices.values()) {
                    if (device.get_action_enabled(action)) {
                        devices.push(device);
                    }
                }

                if (devices.length === 1) {
                    devices[0].activate_action(action, parameter);
                } else if (devices.length > 1) {
                    let win = new ServiceUI.DeviceChooserDialog({
                        title: title,
                        devices: devices
                    });

                    if (win.run() === Gtk.ResponseType.OK) {
                        win.get_device().activate_action(action, parameter);
                    }

                    win.destroy();
                }
            } catch (e) {
                logWarning(e, `GSConnect: Opening ${file.get_uri()}:`);
            }
        }
    }

    vfunc_shutdown() {
        super.vfunc_shutdown();

        log('GSConnect: Shutting down');

        this.lanService.destroy();
        this.bluetoothService.destroy();
        this.notificationListener.destroy();
    }
});

(new Daemon()).run([System.programInvocationName].concat(ARGV));

