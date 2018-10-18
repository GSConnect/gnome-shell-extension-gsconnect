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

// Find the root datadir of the extension
function get_datadir() {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

window.gsconnect = { extdatadir: get_datadir() };
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const Bluetooth = imports.service.bluetooth;
const Core = imports.service.core;
const Device = imports.service.device;
const Lan = imports.service.lan;

const ServiceUI = imports.service.ui.service;
const Settings = imports.service.ui.settings;

const _GITHUB = 'https://github.com/andyholmes/gnome-shell-extension-gsconnect';


const Service = GObject.registerClass({
    GTypeName: 'GSConnectService',
    Properties: {
        'devices': GObject.param_spec_variant(
            'devices',
            'Devices',
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
            'deviceName',
            'The name announced to the network',
            GObject.ParamFlags.READWRITE,
            'GSConnect'
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'deviceType',
            'The service device type',
            GObject.ParamFlags.READABLE,
            'desktop'
        )
    }
}, class Service extends Gtk.Application {

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
        if (this._certificate === undefined) {
            let certPath = gsconnect.configdir + '/certificate.pem';
            let keyPath = gsconnect.configdir + '/private.pem';

            this._certificate = Gio.TlsCertificate.new_for_paths(
                certPath,
                keyPath
            );
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
                    tcpPort: 1716,
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
                let type = GLib.file_get_contents('/sys/class/dmi/id/chassis_type')[1];

                if (type instanceof Uint8Array) {
                    type = imports.byteArray.toString(type);
                }

                type = Number(type);
                this._type = [8, 9, 10, 14].includes(type) ? 'laptop' : 'desktop';
            } catch (e) {
                this._type = 'desktop';
            }
        }

        return this._type;
    }

    /**
     * Send identity to @address or broadcast if %null
     *
     * @param {string|Gio.InetSocketAddress} - TCP address, bluez path or %null
     */
    broadcast(address=null) {
        try {
            switch (true) {
                case (address instanceof Gio.InetSocketAddress):
                    this.lan.broadcast(address);
                    break;

                case (typeof address === 'string'):
                    this.bluetooth.broadcast(address);
                    break;

                // We only do true "broadcasts" for LAN
                default:
                    this.lan.broadcast();
            }
        } catch (e) {
            logError(e);
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
            debug(`GSConnect: Adding ${packet.body.deviceName}`);

            // TODO: Remove when all clients support bluetooth-like discovery
            //
            // If this is the third device to connect, disable discovery to
            // avoid choking on networks with a large amount of devices
            if (this._devices.size === 2 && this.discoverable) {
                this.activate_action('discoverable', null);

                let error = new Error();
                error.name = 'DiscoveryWarning';
                this.notify_error(error);
            }

            device = new Device.Device(packet);
            this._devices.set(device.id, device);

            gsconnect.settings.set_strv('devices', this.devices);
            this.notify('devices');

            device.loadPlugins();
        }

        return device;
    }

    async _pruneDevices() {
        // Don't prune devices while the settings window is open; this also
        // prevents devices from being pruned while being deleted.
        if (this._window && this._window.visible) {
            return;
        }

        for (let [id, device] of this._devices.entries()) {
            if (!device.connected && !device.paired) {
                device.destroy();
                this._devices.delete(id);
                gsconnect.settings.set_strv('devices', this.devices);
            }
        }

        this.notify('devices');
    }

    /**
     * Delete a known device.
     *
     * Removes the device from the list of known devices, unpairs it, destroys
     * it and deletes all GSettings and cached files.
     *
     * @param {String} id - The id of the device to delete
     */
    deleteDevice(id) {
        let device = this._devices.get(id);

        if (device) {
            // Stash the settings path before unpairing and removing
            let settings_path = device.settings.path;
            device.sendPacket({ type: 'kdeconnect.pair', pair: 'false' });

            //
            device.destroy();
            this._devices.delete(id);

            // Delete all GSettings
            GLib.spawn_command_line_async(`dconf reset -f ${settings_path}`);

            // Delete the cache
            let cache = GLib.build_filenamev([gsconnect.cachedir, id]);
            Gio.File.rm_rf(cache);

            // Notify
            gsconnect.settings.set_strv('devices', this.devices);
            this.notify('devices');
        }
    }

    /**
     * Service GActions
     */
    _initActions() {
        let actions = [
            // Device
            ['deviceAction', this._deviceAction.bind(this), '(ssbv)'],

            // App Menu
            ['connect', this._connectAction.bind(this)],
            ['preference', this._preferencesAction.bind(this), 's'],
            ['preferences', this._preferencesAction.bind(this)],
            ['about', this._aboutAction.bind(this)],

            // Misc service actions
            ['broadcast', this.broadcast.bind(this)],
            ['error', this._errorAction.bind(this), 'a{ss}'],
            ['log', this._logAction.bind(this)],
            ['debugger', this._debuggerAction.bind(this)],
            ['wiki', this._wikiAction.bind(this), 's'],
            ['quit', () => this.quit()]
        ];

        for (let [name, callback, type] of actions) {
            let action = new Gio.SimpleAction({
                name: name,
                parameter_type: (type) ? new GLib.VariantType(type) : null
            });
            action.connect('activate', callback);
            this.add_action(action);
        }

        this.add_action(gsconnect.settings.create_action('discoverable'));
    }

    /**
     * A wrapper for Device GActions. This is used to route device notification
     * actions to their device, since GNotifications need an 'app' level action.
     *
     * @param {Gio.Action} action - ...
     * @param {GLib.Variant(av)} parameter - ...
     * @param {GLib.Variant(s)} parameter[0] - Device Id or '*' for all
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

    _connectAction() {
        (new ServiceUI.DeviceConnectDialog()).show_all();
    }

    _preferencesAction(page=null, parameter=null) {
        if (parameter instanceof GLib.Variant) {
            page = parameter.unpack();
        }

        if (!this._window) {
            this._window = new Settings.Window({ application: this });
        }

        // Open to a specific page
        if (page) {
            this._window.switcher.foreach(row => {
                if (row.get_name() === page) {
                    this._window.switcher.select_row(row);
                    return;
                }
            });
        // Open the main page
        } else {
            this._window._onPrevious();
        }

        this._window.present();
    }

    _aboutAction() {
        let modal = (this.get_active_window());
        let transient_for = this.get_active_window();

        if (this._about === undefined) {
            this._about = new Gtk.AboutDialog({
                application: this,
                authors: [
                    'Andy Holmes <andrew.g.r.holmes@gmail.com>',
                    'Bertrand Lacoste <getzze@gmail.com>'
                ],
                comments: _('A complete KDE Connect implementation for GNOME'),
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
            this._about.connect('delete-event', () => this._about.hide_on_delete());
        }

        this._about.modal = modal;
        this._about.transient_for = transient_for;
        this._about.present();
    }

    _errorAction(action, parameter) {
        try {
            let error = parameter.deep_unpack();
            let dialog = new Gtk.MessageDialog({
                text: error.message.trim(),
                secondary_text: error.stack.trim(),
                buttons: Gtk.ButtonsType.CLOSE,
                message_type: Gtk.MessageType.ERROR,
            });
            let issues = dialog.add_button(_('Report'), 1);
            dialog.set_keep_above(true);

            let [message, stack] = dialog.get_message_area().get_children();
            message.halign = Gtk.Align.START;
            message.selectable = true;
            stack.selectable = true;

            dialog.connect('response', (dialog, id) => {
                if (id === 1) {
                    let query = encodeURIComponent(dialog.text).replace('%20', '+');
                    this._github(`issues?q=is%3Aissue+"${query}"`);
                } else {
                    dialog.destroy();
                }
            });

            dialog.show();
        } catch (e) {
            logError(e);
        }
    }

    _logAction() {
        // Ensure debugging is enabled
        gsconnect.settings.set_boolean('debug', true);

        // Launch a terminal with tabs for GJS and GNOME Shell
        GLib.spawn_command_line_async(
            'gnome-terminal ' +
            `--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ` +
            '--tab --title "GNOME Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
        );
    }

    _debuggerAction() {
        (new imports.service.components.debug.Window()).present();
    }

    _wikiAction(action, parameter) {
        this._github(`wiki/${parameter.unpack()}`);
    }

    _github(path=[]) {
        let uri = [_GITHUB].concat(path.split('/')).join('/');

        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (src, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                logError(e);
            }
        });
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
    remove_notification(id, application=null) {
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

    /**
     * Report a service-level error
     *
     * @param {object} error - An Error or object with name, message and stack
     * @param {string} context - The scope of the error
     */
    notify_error(error) {
        try {
            // Always log the error
            logError(error);

            // Create an new notification
            let id, title, body, icon, action;
            let notif = new Gio.Notification();
            notif.set_priority(Gio.NotificationPriority.URGENT);

            switch (error.name) {
                // A TLS certificate failure
                case 'AuthenticationError':
                    id = `${Date.now()}`;
                    title = _('Authentication Failure');
                    let time = GLib.DateTime.new_now_local().format('%F %R');
                    body = `"${error.deviceName}"@${error.deviceHost} (${time})`;
                    icon = new Gio.ThemedIcon({ name: 'dialog-error' });
                    break;

                case 'LanError':
                case 'ProxyError':
                    id = error.name;
                    title = _('Network Error');
                    body = error.message + '\n\n' + _('Click for help troubleshooting');
                    icon = new Gio.ThemedIcon({ name: 'network-error' });
                    notif.set_default_action(
                        `app.wiki('Help#${error.name}')`
                    );
                    break;

                case 'GvcError':
                    id = error.name;
                    title = _('PulseAudio Error');
                    body = _('Click for help troubleshooting');
                    icon = new Gio.ThemedIcon({ name: 'dialog-error' });
                    notif.set_default_action(
                        `app.wiki('Help#${error.name}')`
                    );
                    break;

                case 'DiscoveryWarning':
                    id = 'discovery-warning';
                    title = _('Discovery Disabled');
                    body = _('Discovery has been disabled due to the number of devices on this network.') +
                           '\n\n' +
                           _('Click to open preferences');
                    icon = new Gio.ThemedIcon({ name: 'dialog-warning' });
                    notif.set_default_action('app.preference::service');
                    notif.set_priority(Gio.NotificationPriority.NORMAL);
                    break;

                // Missing sshfs, libcanberra
                case 'DependencyError':
                    id = 'dependency-error';
                    title = _('Additional Software Required');
                    body = _('Click to open preferences');
                    icon = new Gio.ThemedIcon({ name: 'system-software-install-symbolic' });
                    notif.set_default_action('app.preference::other');
                    notif.set_priority(Gio.NotificationPriority.HIGH);
                    break;

                case 'PluginError':
                    id = `${error.plugin}-error`;
                    title = _('%s Plugin Failed To Load').format(error.label);
                    body = error.message + '\n\n' + _('Click for more information');
                    icon = new Gio.ThemedIcon({ name: 'dialog-error' });

                    error = new GLib.Variant('a{ss}', {
                        name: error.name,
                        message: error.message,
                        stack: error.stack
                    });

                    notif.set_default_action_and_target('app.error', error);
                    notif.set_priority(Gio.NotificationPriority.HIGH);
                    break;

                case 'SSHSignatureError':
                    id = error.name;
                    title = _('Remote Filesystem Error');
                    body = _('%s is using an incompatible SSH library').format(error.deviceName) + '\n\n' +
                           _('Click for more information');
                    icon = new Gio.ThemedIcon({ name: 'dialog-error' });
                    notif.set_default_action(
                        `app.wiki('Help#${error.name}')`
                    );
                    notif.set_priority(Gio.NotificationPriority.HIGH);
                    break;

                case 'WaylandNotSupported':
                    id = error.name;
                    title = _('Wayland Not Supported');
                    body = _('Remote input not supported on Wayland') + '\n\n' +
                           _('Click for more information');
                    icon = new Gio.ThemedIcon({ name: 'preferences-desktop-display-symbolic' });
                    notif.set_default_action(
                        `app.wiki('Help#${error.name}')`
                    );
                    notif.set_priority(Gio.NotificationPriority.HIGH);
                    break;

                default:
                    id = `${Date.now()}`;
                    title = error.name;
                    body = error.message.trim();
                    icon = new Gio.ThemedIcon({ name: 'dialog-error' });
                    error = new GLib.Variant('a{ss}', {
                        name: error.name,
                        message: error.message,
                        stack: error.stack
                    });
                    notif.set_default_action_and_target('app.error', error);
                    notif.set_priority(Gio.NotificationPriority.HIGH);
            }

            // Create an urgent notification
            notif.set_title(_('GSConnect: %s').format(title));
            notif.set_body(body);
            notif.set_icon(icon);

            // Bypass override
            super.send_notification(id, notif);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Load each script in components/ and instantiate a Service if it has one
     */
    _loadComponents() {
        for (let name in imports.service.components) {
            try {
                let module = imports.service.components[name];

                if (module.hasOwnProperty('Service')) {
                    this[name] = new module.Service();
                }
            } catch (e) {
                this.notify_error(e);
            }
        }
    }

    vfunc_activate() {
        // TODO: this causes problems right now because the bluetooth service
        // clobbers open TCP channels sometimes, and this gets called often
        //this.broadcast();
    }

    vfunc_startup() {
        super.vfunc_startup();

        this.hold();

        // Watch *this* file and stop the service if it's updated/uninstalled
        this._serviceMonitor = Gio.File.new_for_path(
            gsconnect.extdatadir + '/service/daemon.js'
        ).monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this._serviceMonitor.connect('changed', () => this.quit());

        // Init some resources
        let provider = new Gtk.CssProvider();
        provider.load_from_resource(gsconnect.app_path + '/application.css');
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

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
        });

        // GActions
        this._initActions();

        // Components (PulseAudio, UPower, etc)
        this._loadComponents();

        // Track devices with id as key
        this._devices = new Map();

        // Load cached devices
        let cached = gsconnect.settings.get_strv('devices');
        debug(`Loading ${cached.length} device(s) from cache`);
        cached.map(id => {
            let device = new Device.Device({ body: { deviceId: id } });
            this._devices.set(device.id, device);
            device.loadPlugins();
        });
        this.notify('devices');

        // Lan.ChannelService
        try {
            this.lan = new Lan.ChannelService();
        } catch (e) {
            e.name = 'LanError';
            this.notify_error(e);
        }

        // Bluetooth.ChannelService
        try {
            this.bluetooth = new Bluetooth.ChannelService();
        } catch (e) {
            if (this.bluetooth) {
                this.bluetooth.destroy();
            }
        }
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
                    action = 'shareUri';
                    parameter = new GLib.Variant('s', file.get_uri());
                } else {
                    return;
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
                logError(e, `GSConnect: Opening ${file.get_uri()}:`);
            }
        }
    }

    vfunc_shutdown() {
        super.vfunc_shutdown();

        this._devices.forEach(device => device.destroy());

        if (this.mpris) {
            this.mpris.destroy();
        }

        if (this.notification) {
            this.notification.destroy();
        }

        if (this.lan) {
            this.lan.destroy();
        }

        // FIXME: Really, really bad hack, but sometimes hangs in bluez can
        // prevent the service from stopping or even hang the desktop.
        System.exit(0);
        if (this.bluetooth) {
            this.bluetooth.destroy();
        }
    }
});

(new Service()).run([System.programInvocationName].concat(ARGV));

