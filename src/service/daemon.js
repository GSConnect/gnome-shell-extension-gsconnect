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
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Find the root datadir of the extension
function get_datadir() {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

window.gsconnect = {extdatadir: get_datadir()};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const Bluetooth = imports.service.protocol.bluetooth;
const Core = imports.service.protocol.core;
const Device = imports.service.device;
const Lan = imports.service.protocol.lan;

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
            flags: Gio.ApplicationFlags.HANDLES_OPEN |
                   Gio.ApplicationFlags.HANDLES_COMMAND_LINE
        });

        GLib.set_prgname(gsconnect.app_id);
        GLib.set_application_name('GSConnect');

        // Track devices with id as key
        this._devices = new Map();

        // Properties
        gsconnect.settings.bind('discoverable', this, 'discoverable', 0);
        gsconnect.settings.bind('public-name', this, 'name', 0);
        
        // Command-line
        this._initOptions();
    }

    get certificate() {
        if (this._certificate === undefined) {
            this._certificate = Gio.TlsCertificate.new_for_paths(
                GLib.build_filenamev([gsconnect.configdir, 'certificate.pem']),
                GLib.build_filenamev([gsconnect.configdir, 'private.pem'])
            );
        }

        return this._certificate;
    }

    get devices() {
        return Array.from(this._devices.keys());
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
                    deviceName: this.name,
                    deviceType: this.type,
                    tcpPort: 1716,
                    protocolVersion: 7,
                    incomingCapabilities: [],
                    outgoingCapabilities: []
                }
            });

            for (let name in imports.service.plugins) {
                // Don't report mousepad support in Wayland sessions
                if (_WAYLAND && name == 'mousepad') continue;

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
    broadcast(address = null) {
        try {
            switch (true) {
                case (address instanceof Gio.InetSocketAddress):
                    this.lan.broadcast(address);
                    break;

                case (typeof address === 'string'):
                    this.bluetooth.broadcast(address);
                    break;

                // If not discoverable we'll only broadcast to paired devices
                case !this.discoverable:
                    this.reconnect();
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
     * Try to reconnect to each paired device that has disconnected
     */
    reconnect() {
        for (let [id, device] of this._devices.entries()) {
            if (!device.connected) {
                if (device.paired) {
                    device.activate();

                // Prune the device if the settings window is not open
                } else if (!this._window || !this._window.visible) {
                    device.destroy();
                    this._devices.delete(id);
                    gsconnect.settings.set_strv('devices', this.devices);
                    this.notify('devices');
                }
            }
        }

        return GLib.SOURCE_CONTINUE;
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
            debug(`Adding ${packet.body.deviceName}`);

            // TODO: Remove when all clients support bluetooth-like discovery
            //
            // If this is the third unpaired device to connect, we disable
            // discovery to avoid choking on networks with many devices
            let unpaired = Array.from(this._devices.values()).filter(dev => {
                return !dev.paired;
            });

            if (unpaired.length === 3 && this.discoverable) {
                this.activate_action('discoverable', null);

                let error = new Error();
                error.name = 'DiscoveryWarning';
                this.notify_error(error);
            }

            device = new Device.Device(packet);
            this._devices.set(device.id, device);
            device.loadPlugins();

            gsconnect.settings.set_strv('devices', this.devices);
            this.notify('devices');
        }

        return device;
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
            device.sendPacket({
                type: 'kdeconnect.pair',
                body: {pair: false}
            });

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
            ['broadcast', this.broadcast.bind(this)],
            ['devel', this._devel.bind(this)],
            ['device', this._device.bind(this), '(ssbv)'],
            ['error', this._error.bind(this), 'a{ss}'],
            ['settings', this._settings.bind(this)],
            ['wiki', this._wiki.bind(this), 's']
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

        this.set_accels_for_action('app.wiki::Help', ['F1']);
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
    _device(action, parameter) {
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

    _devel() {
        (new imports.service.ui.devel.Window()).present();
    }

    _error(action, parameter) {
        try {
            let error = parameter.deep_unpack();
            let dialog = new Gtk.MessageDialog({
                text: error.message,
                secondary_text: error.stack,
                buttons: Gtk.ButtonsType.CLOSE,
                message_type: Gtk.MessageType.ERROR,
            });
            dialog.add_button(_('Report'), Gtk.ResponseType.OK);
            dialog.set_keep_above(true);

            let [message, stack] = dialog.get_message_area().get_children();
            message.halign = Gtk.Align.START;
            message.selectable = true;
            stack.selectable = true;

            dialog.connect('response', (dialog, response_id) => {
                if (response_id === Gtk.ResponseType.OK) {
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

    _settings(page = null, parameter = null) {
        if (parameter instanceof GLib.Variant) {
            page = parameter.unpack();
        }

        if (!this._window) {
            this._window = new Settings.Window();
        }

        // Open to a specific page
        if (typeof page === 'string' && this._window.stack.get_child_by_name(page)) {
            this._window._onDeviceSelected(page);

        // Open the main page
        } else {
            this._window._onPrevious();
        }

        this._window.present();
    }

    _wiki(action, parameter) {
        this._github(`wiki/${parameter.unpack()}`);
    }

    _github(path = []) {
        let uri = [_GITHUB].concat(path.split('/')).join('/');
        open_uri(uri);
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
    remove_notification(id, application = null) {
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
            Gio.DBusCallFlags.NONE, -1, null,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );
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
            let id, title, body, icon, priority, time;
            let notif = new Gio.Notification();

            switch (error.name) {
                // A TLS certificate failure
                case 'AuthenticationError':
                    id = `"${error.deviceName}"@${error.deviceHost}`;
                    title = _('Authentication Failure');
                    time = GLib.DateTime.new_now_local().format('%F %R');
                    body = `"${error.deviceName}"@${error.deviceHost} (${time})`;
                    icon = new Gio.ThemedIcon({name: 'dialog-error'});
                    priority = Gio.NotificationPriority.URGENT;
                    break;

                case 'LanError':
                    id = error.name;
                    title = _('Network Error');
                    body = _('Click for help troubleshooting');
                    icon = new Gio.ThemedIcon({name: 'network-error'});
                    priority = Gio.NotificationPriority.URGENT;
                    notif.set_default_action(`app.wiki('Help#${error.name}')`);
                    break;

                case 'DiscoveryWarning':
                    id = 'discovery-warning';
                    title = _('Discovery Disabled');
                    body = _('Discovery has been disabled due to the number of devices on this network.');
                    icon = new Gio.ThemedIcon({name: 'dialog-warning'});
                    priority = Gio.NotificationPriority.NORMAL;
                    notif.set_default_action('app.settings');
                    break;

                case 'PluginError':
                    id = `${error.plugin}-error`;
                    title = _('%s Plugin Failed To Load').format(error.plugin);
                    body = _('Click for more information');
                    icon = new Gio.ThemedIcon({name: 'dialog-error'});
                    priority = Gio.NotificationPriority.HIGH;
                    error = new GLib.Variant('a{ss}', {
                        name: error.name.trim(),
                        message: error.message.trim(),
                        stack: error.stack.trim()
                    });
                    notif.set_default_action_and_target('app.error', error);
                    break;

                default:
                    id = `${Date.now()}`;
                    title = error.name.trim();
                    body = _('Click for more information');
                    icon = new Gio.ThemedIcon({name: 'dialog-error'});
                    error = new GLib.Variant('a{ss}', {
                        name: error.name.trim(),
                        message: error.message.trim(),
                        stack: error.stack.trim()
                    });
                    notif.set_default_action_and_target('app.error', error);
                    priority = Gio.NotificationPriority.HIGH;
            }

            // Create an urgent notification
            notif.set_title(`GSConnect: ${title}`);
            notif.set_body(body);
            notif.set_icon(icon);
            notif.set_priority(priority);

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
                logError(e);
            }
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
            gsconnect.extdatadir + '/service/daemon.js'
        ).monitor(
            Gio.FileMonitorFlags.WATCH_MOVES,
            null
        );
        this._serviceMonitor.connect('changed', () => this.quit());

        // Changing the default public name to the computer's hostname
        if (this.name.length === 0) {
            gsconnect.settings.set_string('public-name', GLib.get_host_name());
        }

        // Init some resources
        let provider = new Gtk.CssProvider();
        provider.load_from_resource(gsconnect.app_path + '/application.css');
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // Ensure our handlers are registered
        try {
            let appInfo = Gio.DesktopAppInfo.new(`${gsconnect.app_id}.desktop`);
            appInfo.add_supports_type('x-scheme-handler/sms');
            appInfo.add_supports_type('x-scheme-handler/tel');
        } catch (e) {
            warning(e);
        }

        // Keep identity updated and broadcast any name changes
        gsconnect.settings.connect('changed::public-name', (settings) => {
            this.identity.body.deviceName = this.name;
        });

        // GActions
        this._initActions();

        // Components (PulseAudio, UPower, etc)
        this._loadComponents();

        // Lan.ChannelService
        try {
            this.lan = new Lan.ChannelService();
        } catch (e) {
            e.name = 'LanError';
            this.notify_error(e);
        }

        // Bluetooth.ChannelService
        try {
            //this.bluetooth = new Bluetooth.ChannelService();
        } catch (e) {
            if (this.bluetooth) {
                this.bluetooth.destroy();
            }
        }

        // Load cached devices
        for (let id of gsconnect.settings.get_strv('devices')) {
            let device = new Device.Device({body: {deviceId: id}});
            this._devices.set(id, device);
            device.loadPlugins();
        }

        GLib.timeout_add_seconds(300, 5, this.reconnect.bind(this));
    }

    vfunc_dbus_register(connection, object_path) {
        this.objectManager = new Gio.DBusObjectManagerServer({
            connection: connection,
            object_path: object_path
        });
        
        return true;
    }

    vfunc_open(files, hint) {
        super.vfunc_open(files, hint);

        for (let file of files) {
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
                        warning(`Unsupported URI: ${file.get_uri()}`);
                        return;
                }

                // Show chooser dialog
                new ServiceUI.DeviceChooserDialog({
                    title: title,
                    action: action,
                    parameter: parameter
                });
            } catch (e) {
                logError(e, `GSConnect: Opening ${file.get_uri()}:`);
            }
        }
    }

    vfunc_shutdown() {
        // Destroy the channel providers first to avoid any further connections
        try {
            if (this.lan) this.lan.destroy();
        } catch (e) {
            debug(e);
        }

        try {
            if (this.bluetooth) this.bluetooth.destroy();
        } catch (e) {
            debug(e);
        }

        // This must be done before ::dbus-unregister is emitted
        this._devices.forEach(device => device.destroy());

        // Destroy the remaining components last
        try {
            if (this.clipboard) this.clipboard.destroy();
        } catch (e) {
            debug(e);
        }
        
        try {
            if (this.mpris) this.mpris.destroy();
        } catch (e) {
            debug(e);
        }

        try {
            if (this.notification) this.notification.destroy();
        } catch (e) {
            debug(e);
        }

        // Chain up last (application->priv->did_shutdown)
        super.vfunc_shutdown();
    }
    
    /*
     * CLI
     */
    _initOptions() {
        this.add_main_option(
            'list-devices',
            'l'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List all devices'),
            null
        );
        
        this.add_main_option(
            'list-available',
            'a'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List available devices (connected and paired)'),
            null
        );
        
        this.add_main_option(
            'device',
            'd'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('ID of a device to handle command'),
            '<device-id>'
        );
        
        this.add_main_option(
            'file',
            'f'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.FILENAME_ARRAY,
            _('Share a local or remote file, by URI or absolute file path'),
            '<filepath|URI>'
        );
        
        this.add_main_option(
            'notification',
            'n'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Send a notification'),
            null
        );
        
        this.add_main_option(
            'photo',
            'c'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Take a photo with the device camera'),
            null
        );
        
        this.add_main_option(
            'ping',
            'p'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ping the device'),
            null
        );
        
        this.add_main_option(
            'ring',
            'r'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ring the device'),
            null
        );
        
        this.add_main_option(
            'sms',
            's'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Send an SMS message'),
            '<phone-number>'
        );
        
        this.add_main_option(
            'url',
            'u'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING_ARRAY,
            _('Send a URL'),
            '<URL>'
        );
        
        this.add_main_option(
            'title',
            't'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Set the title for a notification'),
            '<title>'
        );
        
        this.add_main_option(
            'body',
            'b'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Set the body for a notification, ping or SMS'),
            '<body>'
        );
        
        this.add_main_option(
            'icon',
            'i'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Set the icon name for a notification'),
            '<icon-name>'
        );
        
        this.add_main_option(
            'version',
            'v'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Show release version'),
            null
        );
    }
    
    _listDevices(available = true) {
        try {
            let result = Gio.DBus.session.call_sync(
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
            
            let variant = result.unpack()[0].unpack();
            let device;
            
            for (let object of Object.values(variant)) {
                object = object.full_unpack();
                device = object['org.gnome.Shell.Extensions.GSConnect.Device'];
                
                if (!available || (device.Connected && device.Paired)) {
                    print(device.Id);
                }
            }
        } catch (e) {
            logError(e);
        }
    }
    
    _cliFile(device, options) {
        try {
            let plugin = device.lookup_plugin('share');
            
            if (!plugin) {
                throw new Error('Share plugin disabled');
            }
            
            let uris = options.lookup_value('file', null).deep_unpack();
            
            uris.map(uri => {
                if (uri instanceof Uint8Array) {
                    uri = imports.byteArray.toString(uri);
                }
                
                plugin.shareFile(uri);
            });
        } catch (e) {
            logError(e);
        }
    }
    
    async _cliNotify(device, options) {
        try {
            let plugin = device.lookup_plugin('notification');
            
            if (!plugin) {
                throw new Error('Notification plugin disabled');
            }
            
            let title = 'GSConnect';
            let body = '';
            let icon = null;
            
            if (options.contains('title')) {
                title = options.lookup_value('title', null).unpack();
            }
            
            if (options.contains('body')) {
                body = options.lookup_value('body', null).unpack();
            }
            
            if (options.contains('icon')) {
                icon = options.lookup_value('icon', null).unpack();
            }

            let packet = {
                type: 'kdeconnect.notification',
                body: {
                    id: `${Date.now()}`,
                    appName: title,
                    ticker: body,
                    isClearable: false
                }
            };

            await plugin._uploadIcon(packet, icon);
        } catch (e) {
            logError(e);
        }
    }
    
    _cliPhoto(device) {
        try {
            let plugin = device.lookup_plugin('findmyphone');
            
            if (!plugin) {
                throw new Error('Photo plugin disabled');
            }
            
            plugin.photo();
        } catch (e) {
            logError(e);
        }
    }
    
    _cliPing(device, options) {
        try {
            let plugin = device.lookup_plugin('ping');
            
            if (!plugin) {
                throw new Error('Ping plugin disabled');
            }
            
            let body = '';
            
            if (options.contains('body')) {
                body = options.lookup_value('body', null).deep_unpack();
            }
            
            plugin.ping(body);
        } catch (e) {
            logError(e);
        }
    }
    
    _cliRing(device) {
        try {
            let plugin = device.lookup_plugin('findmyphone');
            
            if (!plugin) {
                throw new Error('FindMyPhone plugin disabled');
            }
            
            plugin.ring();
        } catch (e) {
            logError(e);
        }
    }
    
    _cliSms(device, options) {
        try {
            let plugin = device.lookup_plugin('sms');
            
            if (!plugin) {
                throw new Error('SMS plugin disabled');
            }
            
            if (!options.contains('body')) {
                throw new Error('SMS body missing');
            }
            
            let address = options.lookup_value('sms', null).deep_unpack();
            let body = options.lookup_value('body', null).deep_unpack();
            
            plugin.sendSms(address, body);
        } catch (e) {
            logError(e);
        }
    }
    
    _cliUrl(device, options) {
        try {
            let plugin = device.lookup_plugin('share');
            
            if (!plugin) {
                throw new Error('Share plugin disabled');
            }
            
            let uris = options.lookup_value('url', null).deep_unpack();
            
            uris.map(uri => {
                if (uri instanceof Uint8Array) {
                    uri = imports.byteArray.toString(uri);
                }
                
                plugin.shareUri(uri);
            });
        } catch (e) {
            logError(e);
        }
    }
    
    vfunc_handle_local_options(options) {
        if (options.contains('version')) {
            print(`GSConnect ${gsconnect.metadata.version}`);
            return 0;
        }

        try {
            this.register(null);
        } catch (e) {
            return 1;
        }
        
        if (options.contains('list-available')) {
            this._listDevices(true);
            return 0;
        }
        
        if (options.contains('list-devices')) {
            this._listDevices(false);
            return 0;
        }
        
        return -1;
    }
    
    vfunc_command_line(command_line) {
        try {
            let options = command_line.get_options_dict();
            
            if (!options.contains('device')) return;
            
            let id = options.lookup_value('device', null).unpack();
            let device = this._devices.get(id);
            
            if (!device || !device.connected || !device.paired) {
                throw new Error(`Device not available: ${id}`);
            }
            
            if (options.contains('file')) {
                this._cliFile(device, options);
            }
            
            if (options.contains('notification')) {
                this._cliNotify(device, options);
            }
            
            if (options.contains('photo')) {
                this._cliPhoto(device, options);
            }
            
            if (options.contains('ping')) {
                this._cliPing(device, options);
            }
            
            if (options.contains('ring')) {
                this._cliRing(device, options);
            }
            
            if (options.contains('sms')) {
                this._cliSms(device, options);
            }
            
            if (options.contains('url')) {
                this._cliUrl(device, options);
            }
        } catch (e) {
            logError(e);
        }
        
        return 0;
    }
});

(new Service()).run([System.programInvocationName].concat(ARGV));

