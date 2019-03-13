'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GjsPrivate = imports.gi.GjsPrivate;


let _nodeInfo = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg name="appName" type="s" direction="in"/>
      <arg name="replacesId" type="u" direction="in"/>
      <arg name="iconName" type="s" direction="in"/>
      <arg name="summary" type="s" direction="in"/>
      <arg name="body" type="s" direction="in"/>
      <arg name="actions" type="as" direction="in"/>
      <arg name="hints" type="a{sv}" direction="in"/>
      <arg name="timeout" type="i" direction="in"/>
    </method>
  </interface>
  <interface name="org.gtk.Notifications">
    <method name="AddNotification">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="a{sv}" direction="in"/>
    </method>
    <method name="RemoveNotification">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
    </method>
  </interface>
</node>
`);


const FDO_IFACE = _nodeInfo.lookup_interface('org.freedesktop.Notifications');
const FDO_MATCH = "interface='org.freedesktop.Notifications',member='Notify',type='method_call'";

const GTK_IFACE = _nodeInfo.lookup_interface('org.gtk.Notifications');
const GTK_MATCH = "interface='org.gtk.Notifications',member='AddNotification',type='method_call'";


/**
 * A class for snooping Freedesktop (libnotify) and Gtk (GNotification)
 * notifications and forwarding them to supporting devices.
 */
var Listener = class Listener {
    constructor() {
        // Respect desktop notification settings
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications'
        });

        // Watch for new application policies
        this._settingsId = this._settings.connect(
            'changed::application-children',
            this._onSettingsChanged.bind(this)
        );
        this._onSettingsChanged();

        // Cache for appName->desktop-id lookups
        this._names = {};

        // Asynchronous setup
        this._init_async();
    }

    get application() {
        return Gio.Application.get_default();
    }

    get applications() {
        if (this._applications === undefined) {
            this._applications = {};
        }

        return this._applications;
    }

    /**
     * Update application notification settings
     */
    _onSettingsChanged() {
        this._applications = {};

        for (let app of this._settings.get_strv('application-children')) {
            let appSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications.application',
                path: `/org/gnome/desktop/notifications/application/${app}/`
            });

            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string('application-id')
            );

            if (appInfo !== null) {
                this._applications[appInfo.get_name()] = appSettings;
            }
        }
    }

    /**
     * Setup a dedicated DBus connection for monitoring
     */
    _newConnection() {
        return new Promise((resolve, reject) => {
            Gio.DBusConnection.new_for_address(
                Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null),
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                null,
                null,
                (connection, res) => {
                    try {
                        resolve(Gio.DBusConnection.new_for_address_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );

        });
    }

    _getConnection(type = Gio.BusType.SESSION) {
        return new Promise((resolve, reject) => {
            Gio.bus_get(type, null, (connection, res) => {
                try {
                    resolve(Gio.bus_get_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _listNames() {
        return new Promise((resolve, reject) => {
            this._session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _getNameOwner(name) {
        return new Promise((resolve, reject) => {
            this._session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'GetNameOwner',
                new GLib.Variant('(s)', [name]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Try and find a well-known name for @sender on the session bus
     *
     * @param {string} sender - A DBus unique name (eg. :1.2282)
     * @param {string} appName - @appName passed to Notify() (Optional)
     * @return {string} - A well-known name or %null
     */
    async _getAppId(sender, appName) {
        try {
            // Get a list of well-known names, ignoring @sender
            let names = await this._listNames();
            names.splice(names.indexOf(sender), 1);

            // Make a short list for substring matches (fractal/org.gnome.Fractal)
            let appLower = appName.toLowerCase();

            let shortList = names.filter(name => {
                return name.toLowerCase().includes(appLower);
            });

            // Run the short list first
            for (let name of shortList) {
                let nameOwner = await this._getNameOwner(name);

                if (nameOwner === sender) {
                    return name;
                }

                names.splice(names.indexOf(name), 1);
            }

            // Run the full list
            for (let name of names) {
                let nameOwner = await this._getNameOwner(name);

                if (nameOwner === sender) {
                    return name;
                }
            }

            return null;
        } catch (e) {
            debug(e);
            return null;
        }
    }

    /**
     * Try and find the application name for @sender
     *
     * @param {string} sender - A DBus unique name
     * @param {string} appName - (Optional) appName supplied by Notify()
     * @return {string} - A well-known name or %null
     */
    async _getAppName(sender, appName) {
        // Check the cache first
        if (appName && this._names.hasOwnProperty(appName)) {
            return this._names[appName];
        }

        let appId, appInfo;

        try {
            appId = await this._getAppId(sender, appName);
            appInfo = Gio.DesktopAppInfo.new(`${appId}.desktop`);
            this._names[appName] = appInfo.get_name();
            appName = appInfo.get_name();
        } catch (e) {
            // Silence errors
        }

        return appName;
    }

    /**
     * Callback for AddNotification()/Notify()
     */
    async _onHandleMethodCall(impl, name, parameters, invocation) {
        try {
            // Check if notifications are disabled in desktop settings
            if (!this._settings.get_boolean('show-banners')) {
                return;
            }

            parameters = parameters.full_unpack();

            // GNotification
            if (name === 'AddNotification') {
                this.AddNotification(...parameters);

            // libnotify
            } else if (name === 'Notify') {
                // Try to brute-force an application name using DBus
                if (!this.applications.hasOwnProperty(parameters[0])) {
                    let sender = invocation.get_sender();
                    parameters[0] = await this._getAppName(sender, parameters[0]);
                }

                this.Notify(...parameters);
            }
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Export interfaces for proxying notifications and become a monitor
     */
    _monitorConnection() {
        return new Promise((resolve, reject) => {
            // libnotify Interface
            this._fdoNotifications = new GjsPrivate.DBusImplementation({
                g_interface_info: FDO_IFACE
            });
            this._fdoMethodCallId = this._fdoNotifications.connect(
                'handle-method-call',
                this._onHandleMethodCall.bind(this)
            );
            this._fdoNotifications.export(
                this._monitor,
                '/org/freedesktop/Notifications'
            );

            // GNotification Interface
            this._gtkNotifications = new GjsPrivate.DBusImplementation({
                g_interface_info: GTK_IFACE
            });
            this._gtkMethodCallId = this._gtkNotifications.connect(
                'handle-method-call',
                this._onHandleMethodCall.bind(this)
            );
            this._gtkNotifications.export(
                this._monitor,
                '/org/gtk/Notifications'
            );

            // Become a monitor for Fdo & Gtk notifications
            this._monitor.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus.Monitoring',
                'BecomeMonitor',
                new GLib.Variant('(asu)', [[FDO_MATCH, GTK_MATCH], 0]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        resolve(connection.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _init_async() {
        try {
            this._session = await this._getConnection();
            this._monitor = await this._newConnection();
            await this._monitorConnection();
        } catch (e) {
            // FIXME: if something goes wrong the component will appear active
            logError(e);
            this.destroy();
        }
    }

    _sendNotification(notif) {
        // Check if this application is disabled in desktop settings
        let appSettings = this.applications[notif.appName];

        if (appSettings && !appSettings.get_boolean('enable')) {
            return;
        }

        // Send the notification to each supporting device
        let variant = GLib.Variant.full_pack(notif);

        for (let device of this.application._devices.values()) {
            device.activate_action('sendNotification', variant);
        }
    }

    Notify(appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        try {
            // Ignore notifications without an appName
            if (!appName) {
                return;
            }

            this._sendNotification({
                appName: appName,
                id: `fdo|null|${replacesId}`,
                title: summary,
                text: body,
                ticker: `${summary}: ${body}`,
                isClearable: (replacesId !== 0),
                icon: iconName
            });
        } catch (e) {
            debug(e);
        }
    }

    AddNotification(application, id, notification) {
        try {
            // Ignore our own GNotifications
            if (application === 'org.gnome.Shell.Extensions.GSConnect') {
                return;
            }

            let appInfo = Gio.DesktopAppInfo.new(`${application}.desktop`);

            // Try to get an icon for the notification
            if (!notification.hasOwnProperty('icon')) {
                notification.icon = appInfo.get_icon() || undefined;
            }

            this._sendNotification({
                appName: appInfo.get_name(),
                id: `gtk|${application}|${id}`,
                title: notification.title,
                text: notification.body,
                ticker: `${notification.title}: ${notification.body}`,
                isClearable: true,
                icon: notification.icon
            });
        } catch (e) {
            debug(e);
        }
    }

    destroy() {
        try {
            this._fdoNotifications.disconnect(this._fdoMethodCallId);
            this._fdoNotifications.flush();
            this._fdoNotifications.unexport();

            this._gtkNotifications.disconnect(this._gtkMethodCallId);
            this._gtkNotifications.flush();
            this._gtkNotifications.unexport();

            this._settings.disconnect(this._settingsId);

            // TODO: Gio.IOErrorEnum: The connection is closed
            //this._monitor.close_sync(null);
        } catch (e) {
            debug(e);
        }
    }
};


/**
 * The service class for this component
 */
var Service = Listener;

