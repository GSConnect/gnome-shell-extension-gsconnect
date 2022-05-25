#!/usr/bin/env gjs

'use strict';

// Allow TLSv1.0 certificates
// See https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/930
imports.gi.GLib.setenv('G_TLS_GNUTLS_PRIORITY', 'NORMAL:%COMPAT:+VERS-TLS1.0', true);

imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GdkPixbuf = '2.0';
imports.gi.versions.Gio = '2.0';
imports.gi.versions.GIRepository = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Pango = '1.0';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


// Bootstrap
function get_datadir() {
    const m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.unshift(get_datadir());
imports.config.PACKAGE_DATADIR = imports.searchPath[0];


// Local Imports
const Config = imports.config;
const Manager = imports.service.manager;
const ServiceUI = imports.service.ui.service;


/**
 * Class representing the GSConnect service daemon.
 */
const Service = GObject.registerClass({
    GTypeName: 'GSConnectService',
}, class Service extends Gtk.Application {

    _init() {
        super._init({
            application_id: 'org.gnome.Shell.Extensions.GSConnect',
            flags: Gio.ApplicationFlags.HANDLES_OPEN,
            resource_base_path: '/org/gnome/Shell/Extensions/GSConnect',
        });

        GLib.set_prgname('gsconnect');
        GLib.set_application_name('GSConnect');

        // Command-line
        this._initOptions();
    }

    get settings() {
        if (this._settings === undefined) {
            this._settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
            });
        }

        return this._settings;
    }

    /*
     * GActions
     */
    _initActions() {
        const actions = [
            ['connect', this._identify.bind(this), new GLib.VariantType('s')],
            ['device', this._device.bind(this), new GLib.VariantType('(ssbv)')],
            ['error', this._error.bind(this), new GLib.VariantType('a{ss}')],
            ['preferences', this._preferences, null],
            ['quit', () => this.quit(), null],
            ['refresh', this._identify.bind(this), null],
        ];

        for (const [name, callback, type] of actions) {
            const action = new Gio.SimpleAction({
                name: name,
                parameter_type: type,
            });
            action.connect('activate', callback);
            this.add_action(action);
        }
    }

    /**
     * A wrapper for Device GActions. This is used to route device notification
     * actions to their device, since GNotifications need an 'app' level action.
     *
     * @param {Gio.Action} action - The GAction
     * @param {GLib.Variant} parameter - The activation parameter
     */
    _device(action, parameter) {
        try {
            parameter = parameter.unpack();

            // Select the appropriate device(s)
            let devices;
            const id = parameter[0].unpack();

            if (id === '*')
                devices = this.manager.devices.values();
            else
                devices = [this.manager.devices.get(id)];

            // Unpack the action data and activate the action
            const name = parameter[1].unpack();
            const target = parameter[2].unpack() ? parameter[3].unpack() : null;

            for (const device of devices)
                device.activate_action(name, target);
        } catch (e) {
            logError(e);
        }
    }

    _error(action, parameter) {
        try {
            const error = parameter.deepUnpack();

            // If there's a URL, we have better information in the Wiki
            if (error.url !== undefined) {
                Gio.AppInfo.launch_default_for_uri_async(
                    error.url,
                    null,
                    null,
                    null
                );
                return;
            }

            const dialog = new ServiceUI.ErrorDialog(error);
            dialog.present();
        } catch (e) {
            logError(e);
        }
    }

    _identify(action, parameter) {
        try {
            let uri = null;

            if (parameter instanceof GLib.Variant)
                uri = parameter.unpack();

            this.manager.identify(uri);
        } catch (e) {
            logError(e);
        }
    }

    _preferences() {
        Gio.Subprocess.new(
            [`${Config.PACKAGE_DATADIR}/gsconnect-preferences`],
            Gio.SubprocessFlags.NONE
        );
    }

    /**
     * Report a service-level error
     *
     * @param {Object} error - An Error or object with name, message and stack
     */
    notify_error(error) {
        try {
            // Always log the error
            logError(error);

            // Create an new notification
            let id, body, priority;
            const notif = new Gio.Notification();
            const icon = new Gio.ThemedIcon({name: 'dialog-error'});
            let target = null;

            if (error.name === undefined)
                error.name = 'Error';

            if (error.url !== undefined) {
                id = error.url;
                body = _('Click for help troubleshooting');
                priority = Gio.NotificationPriority.URGENT;

                target = new GLib.Variant('a{ss}', {
                    name: error.name.trim(),
                    message: error.message.trim(),
                    stack: error.stack.trim(),
                    url: error.url,
                });
            } else {
                id = error.message.trim();
                body = _('Click for more information');
                priority = Gio.NotificationPriority.HIGH;

                target = new GLib.Variant('a{ss}', {
                    name: error.name.trim(),
                    message: error.message.trim(),
                    stack: error.stack.trim(),
                });
            }

            notif.set_title(`GSConnect: ${error.name.trim()}`);
            notif.set_body(body);
            notif.set_icon(icon);
            notif.set_priority(priority);
            notif.set_default_action_and_target('app.error', target);

            this.send_notification(id, notif);
        } catch (e) {
            logError(e);
        }
    }

    vfunc_activate() {
        super.vfunc_activate();
    }

    vfunc_startup() {
        super.vfunc_startup();

        this.hold();

        // Watch *this* file and stop the service if it's updated/uninstalled
        this._serviceMonitor = Gio.File.new_for_path(
            `${Config.PACKAGE_DATADIR}/service/daemon.js`
        ).monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._serviceMonitor.connect('changed', () => this.quit());

        // Init some resources
        const provider = new Gtk.CssProvider();
        provider.load_from_resource(`${Config.APP_PATH}/application.css`);
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // Ensure our handlers are registered
        try {
            const appInfo = Gio.DesktopAppInfo.new(`${Config.APP_ID}.desktop`);
            appInfo.add_supports_type('x-scheme-handler/sms');
            appInfo.add_supports_type('x-scheme-handler/tel');
        } catch (e) {
            debug(e);
        }

        // GActions & GSettings
        this._initActions();

        this.manager.start();
    }

    vfunc_dbus_register(connection, object_path) {
        if (!super.vfunc_dbus_register(connection, object_path))
            return false;

        this.manager = new Manager.Manager({
            connection: connection,
            object_path: object_path,
        });

        return true;
    }

    vfunc_dbus_unregister(connection, object_path) {
        this.manager.destroy();

        super.vfunc_dbus_unregister(connection, object_path);
    }

    vfunc_open(files, hint) {
        super.vfunc_open(files, hint);

        for (const file of files) {
            let action, parameter, title;

            try {
                switch (file.get_uri_scheme()) {
                    case 'sms':
                        title = _('Send SMS');
                        action = 'uriSms';
                        parameter = new GLib.Variant('s', file.get_uri());
                        break;

                    case 'tel':
                        title = _('Dial Number');
                        action = 'shareUri';
                        parameter = new GLib.Variant('s', file.get_uri());
                        break;

                    case 'file':
                        title = _('Share File');
                        action = 'shareFile';
                        parameter = new GLib.Variant('(sb)', [file.get_uri(), false]);
                        break;

                    default:
                        throw new Error(`Unsupported URI: ${file.get_uri()}`);
                }

                // Show chooser dialog
                new ServiceUI.DeviceChooser({
                    title: title,
                    action_name: action,
                    action_target: parameter,
                });
            } catch (e) {
                logError(e, `GSConnect: Opening ${file.get_uri()}`);
            }
        }
    }

    vfunc_shutdown() {
        // Dispose GSettings
        if (this._settings !== undefined)
            this.settings.run_dispose();

        this.manager.stop();

        // Exhaust the event loop to ensure any pending operations complete
        const context = GLib.MainContext.default();

        while (context.iteration(false))
            continue;

        // Force a GC to prevent any more calls back into JS, then chain-up
        imports.system.gc();
        super.vfunc_shutdown();
    }

    /*
     * CLI
     */
    _initOptions() {
        /*
         * Device Listings
         */
        this.add_main_option(
            'list-devices',
            'l'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List available devices'),
            null
        );

        this.add_main_option(
            'list-all',
            'a'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List all devices'),
            null
        );

        this.add_main_option(
            'device',
            'd'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Target Device'),
            '<device-id>'
        );

        /**
         * Pairing
         */
        this.add_main_option(
            'pair',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Pair'),
            null
        );

        this.add_main_option(
            'unpair',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Unpair'),
            null
        );

        /*
         * Messaging
         */
        this.add_main_option(
            'message',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING_ARRAY,
            _('Send SMS'),
            '<phone-number>'
        );

        this.add_main_option(
            'message-body',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Message Body'),
            '<text>'
        );

        /*
         * Notifications
         */
        this.add_main_option(
            'notification',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Send Notification'),
            '<title>'
        );

        this.add_main_option(
            'notification-appname',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification App Name'),
            '<name>'
        );

        this.add_main_option(
            'notification-body',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification Body'),
            '<text>'
        );

        this.add_main_option(
            'notification-icon',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification Icon'),
            '<icon-name>'
        );

        this.add_main_option(
            'notification-id',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification ID'),
            '<id>'
        );

        this.add_main_option(
            'photo',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Photo'),
            null
        );

        this.add_main_option(
            'ping',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ping'),
            null
        );

        this.add_main_option(
            'ring',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ring'),
            null
        );

        /*
         * Sharing
         */
        this.add_main_option(
            'share-file',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.FILENAME_ARRAY,
            _('Share File'),
            '<filepath|URI>'
        );

        this.add_main_option(
            'share-link',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING_ARRAY,
            _('Share Link'),
            '<URL>'
        );

        this.add_main_option(
            'share-text',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Share Text'),
            '<text>'
        );

        /*
         * Misc
         */
        this.add_main_option(
            'version',
            'v'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Show release version'),
            null
        );
    }

    _cliAction(id, name, parameter = null) {
        const parameters = [];

        if (parameter instanceof GLib.Variant)
            parameters[0] = parameter;

        id = id.replace(/\W+/g, '_');

        Gio.DBus.session.call_sync(
            'org.gnome.Shell.Extensions.GSConnect',
            `/org/gnome/Shell/Extensions/GSConnect/Device/${id}`,
            'org.gtk.Actions',
            'Activate',
            GLib.Variant.new('(sava{sv})', [name, parameters, {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
    }

    _cliListDevices(full = true) {
        const result = Gio.DBus.session.call_sync(
            'org.gnome.Shell.Extensions.GSConnect',
            '/org/gnome/Shell/Extensions/GSConnect',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        const variant = result.unpack()[0].unpack();
        let device;

        for (let object of Object.values(variant)) {
            object = object.recursiveUnpack();
            device = object['org.gnome.Shell.Extensions.GSConnect.Device'];

            if (full)
                print(`${device.Id}\t${device.Name}\t${device.Connected}\t${device.Paired}`);
            else if (device.Connected && device.Paired)
                print(device.Id);
        }
    }

    _cliMessage(id, options) {
        if (!options.contains('message-body'))
            throw new TypeError('missing --message-body option');

        // TODO: currently we only support single-recipient messaging
        const addresses = options.lookup_value('message', null).deepUnpack();
        const body = options.lookup_value('message-body', null).deepUnpack();

        this._cliAction(
            id,
            'sendSms',
            GLib.Variant.new('(ss)', [addresses[0], body])
        );
    }

    _cliNotify(id, options) {
        const title = options.lookup_value('notification', null).unpack();
        let body = '';
        let icon = null;
        let nid = `${Date.now()}`;
        let appName = 'GSConnect CLI';

        if (options.contains('notification-id'))
            nid = options.lookup_value('notification-id', null).unpack();

        if (options.contains('notification-body'))
            body = options.lookup_value('notification-body', null).unpack();

        if (options.contains('notification-appname'))
            appName = options.lookup_value('notification-appname', null).unpack();

        if (options.contains('notification-icon')) {
            icon = options.lookup_value('notification-icon', null).unpack();
            icon = Gio.Icon.new_for_string(icon);
        } else {
            icon = new Gio.ThemedIcon({
                name: 'org.gnome.Shell.Extensions.GSConnect',
            });
        }

        const notification = new GLib.Variant('a{sv}', {
            appName: GLib.Variant.new_string(appName),
            id: GLib.Variant.new_string(nid),
            title: GLib.Variant.new_string(title),
            text: GLib.Variant.new_string(body),
            ticker: GLib.Variant.new_string(`${title}: ${body}`),
            time: GLib.Variant.new_string(`${Date.now()}`),
            isClearable: GLib.Variant.new_boolean(true),
            icon: icon.serialize(),
        });

        this._cliAction(id, 'sendNotification', notification);
    }

    _cliShareFile(device, options) {
        const files = options.lookup_value('share-file', null).deepUnpack();

        for (let file of files) {
            file = imports.byteArray.toString(file);
            this._cliAction(device, 'shareFile', GLib.Variant.new('(sb)', [file, false]));
        }
    }

    _cliShareLink(device, options) {
        const uris = options.lookup_value('share-link', null).unpack();

        for (const uri of uris)
            this._cliAction(device, 'shareUri', uri);
    }

    _cliShareText(device, options) {
        const text = options.lookup_value('share-text', null).unpack();

        this._cliAction(device, 'shareText', GLib.Variant.new_string(text));
    }

    vfunc_handle_local_options(options) {
        try {
            if (options.contains('version')) {
                print(`GSConnect ${Config.PACKAGE_VERSION}`);
                return 0;
            }

            this.register(null);

            if (options.contains('list-devices')) {
                this._cliListDevices(false);
                return 0;
            }

            if (options.contains('list-all')) {
                this._cliListDevices(true);
                return 0;
            }

            // We need a device for anything else; exit since this is probably
            // the daemon being started.
            if (!options.contains('device'))
                return -1;

            const id = options.lookup_value('device', null).unpack();

            // Pairing
            if (options.contains('pair')) {
                this._cliAction(id, 'pair');
                return 0;
            }

            if (options.contains('unpair')) {
                this._cliAction(id, 'unpair');
                return 0;
            }

            // Plugins
            if (options.contains('message'))
                this._cliMessage(id, options);

            if (options.contains('notification'))
                this._cliNotify(id, options);

            if (options.contains('photo'))
                this._cliAction(id, 'photo');

            if (options.contains('ping'))
                this._cliAction(id, 'ping', GLib.Variant.new_string(''));

            if (options.contains('ring'))
                this._cliAction(id, 'ring');

            if (options.contains('share-file'))
                this._cliShareFile(id, options);

            if (options.contains('share-link'))
                this._cliShareLink(id, options);

            if (options.contains('share-text'))
                this._cliShareText(id, options);

            return 0;
        } catch (e) {
            logError(e);
            return 1;
        }
    }
});

(new Service()).run([imports.system.programInvocationName].concat(ARGV));

