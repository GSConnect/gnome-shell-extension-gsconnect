'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GjsPrivate = imports.gi.GjsPrivate;
const GObject = imports.gi.GObject;

const DBus = imports.service.utils.dbus;


const _nodeInfo = Gio.DBusNodeInfo.new_for_xml(`
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
const Listener = GObject.registerClass({
    GTypeName: 'GSConnectNotificationListener',
    Signals: {
        'notification-added': {
            flags: GObject.SignalFlags.RUN_LAST,
            param_types: [GLib.Variant.$gtype],
        },
    },
}, class Listener extends GObject.Object {

    _init() {
        super._init();

        // Respect desktop notification settings
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        // Watch for new application policies
        this._settingsId = this._settings.connect(
            'changed::application-children',
            this._onSettingsChanged.bind(this)
        );

        // Cache for appName->desktop-id lookups
        this._names = {};

        // Asynchronous setup
        this._init_async();
    }

    get applications() {
        if (this._applications === undefined)
            this._onSettingsChanged();

        return this._applications;
    }

    /**
     * Update application notification settings
     */
    _onSettingsChanged() {
        this._applications = {};

        for (const app of this._settings.get_strv('application-children')) {
            const appSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications.application',
                path: `/org/gnome/desktop/notifications/application/${app}/`,
            });

            const appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string('application-id')
            );

            if (appInfo !== null)
                this._applications[appInfo.get_name()] = appSettings;
        }
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
                        resolve(res.deepUnpack()[0]);
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
                        resolve(res.deepUnpack()[0]);
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
     * @return {string} A well-known name or %null
     */
    async _getAppId(sender, appName) {
        try {
            // Get a list of well-known names, ignoring @sender
            const names = await this._listNames();
            names.splice(names.indexOf(sender), 1);

            // Make a short list for substring matches (fractal/org.gnome.Fractal)
            const appLower = appName.toLowerCase();

            const shortList = names.filter(name => {
                return name.toLowerCase().includes(appLower);
            });

            // Run the short list first
            for (const name of shortList) {
                const nameOwner = await this._getNameOwner(name);

                if (nameOwner === sender)
                    return name;

                names.splice(names.indexOf(name), 1);
            }

            // Run the full list
            for (const name of names) {
                const nameOwner = await this._getNameOwner(name);

                if (nameOwner === sender)
                    return name;
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
     * @param {string} [appName] - `appName` supplied by Notify()
     * @return {string} A well-known name or %null
     */
    async _getAppName(sender, appName = null) {
        // Check the cache first
        if (appName && this._names.hasOwnProperty(appName))
            return this._names[appName];

        try {
            const appId = await this._getAppId(sender, appName);
            const appInfo = Gio.DesktopAppInfo.new(`${appId}.desktop`);
            this._names[appName] = appInfo.get_name();
            appName = appInfo.get_name();
        } catch (e) {
            // Silence errors
        }

        return appName;
    }

    /**
     * Callback for AddNotification()/Notify()
     *
     * @param {DBus.Interface} iface - The DBus interface
     * @param {string} name - The DBus method name
     * @param {GLib.Variant} parameters - The method parameters
     * @param {Gio.DBusMethodInvocation} invocation - The method invocation info
     */
    async _onHandleMethodCall(iface, name, parameters, invocation) {
        try {
            // Check if notifications are disabled in desktop settings
            if (!this._settings.get_boolean('show-banners'))
                return;

            parameters = parameters.full_unpack();

            // GNotification
            if (name === 'AddNotification') {
                this.AddNotification(...parameters);

            // libnotify
            } else if (name === 'Notify') {
                const message = invocation.get_message();

                if (this._fdoNameOwner === undefined) {
                    this._fdoNameOwner = await this._getNameOwner(
                        'org.freedesktop.Notifications');
                }

                if (this._fdoNameOwner !== message.get_destination())
                    return;

                // Try to brute-force an application name using DBus
                if (!this.applications.hasOwnProperty(parameters[0])) {
                    const sender = message.get_sender();
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
     *
     * @return {Promise} A promise for the operation
     */
    _monitorConnection() {
        return new Promise((resolve, reject) => {
            // libnotify Interface
            this._fdoNotifications = new GjsPrivate.DBusImplementation({
                g_interface_info: FDO_IFACE,
            });
            this._fdoMethodCallId = this._fdoNotifications.connect(
                'handle-method-call',
                this._onHandleMethodCall.bind(this)
            );
            this._fdoNotifications.export(
                this._monitor,
                '/org/freedesktop/Notifications'
            );

            this._fdoNameOwnerChangedId = this._session.signal_subscribe(
                'org.freedesktop.DBus',
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                '/org/freedesktop/DBus',
                'org.freedesktop.Notifications',
                Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
                this._onFdoNameOwnerChanged.bind(this)
            );

            // GNotification Interface
            this._gtkNotifications = new GjsPrivate.DBusImplementation({
                g_interface_info: GTK_IFACE,
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
            this._session = await DBus.getConnection();
            this._monitor = await DBus.newConnection();
            await this._monitorConnection();
        } catch (e) {
            const service = Gio.Application.get_default();

            if (service !== null)
                service.notify_error(e);
            else
                logError(e);
        }
    }

    _onFdoNameOwnerChanged(connection, sender, object, iface, signal, parameters) {
        this._fdoNameOwner = parameters.deepUnpack()[2];
    }

    _sendNotification(notif) {
        // Check if this application is disabled in desktop settings
        const appSettings = this.applications[notif.appName];

        if (appSettings && !appSettings.get_boolean('enable'))
            return;

        // Send the notification to each supporting device
        // TODO: avoid the overhead of the GAction framework with a signal?
        const variant = GLib.Variant.full_pack(notif);
        this.emit('notification-added', variant);
    }

    Notify(appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        // Ignore notifications without an appName
        if (!appName)
            return;

        this._sendNotification({
            appName: appName,
            id: `fdo|null|${replacesId}`,
            title: summary,
            text: body,
            ticker: `${summary}: ${body}`,
            isClearable: (replacesId !== 0),
            icon: iconName,
        });
    }

    AddNotification(application, id, notification) {
        // Ignore our own notifications or we'll cause a notification loop
        if (application === 'org.gnome.Shell.Extensions.GSConnect')
            return;

        const appInfo = Gio.DesktopAppInfo.new(`${application}.desktop`);

        // Try to get an icon for the notification
        if (!notification.hasOwnProperty('icon'))
            notification.icon = appInfo.get_icon() || undefined;

        this._sendNotification({
            appName: appInfo.get_name(),
            id: `gtk|${application}|${id}`,
            title: notification.title,
            text: notification.body,
            ticker: `${notification.title}: ${notification.body}`,
            isClearable: true,
            icon: notification.icon,
        });
    }

    destroy() {
        try {
            if (this._fdoNotifications) {
                this._fdoNotifications.disconnect(this._fdoMethodCallId);
                this._fdoNotifications.unexport();
                this._session.signal_unsubscribe(this._fdoNameOwnerChangedId);
            }

            if (this._gtkNotifications) {
                this._gtkNotifications.disconnect(this._gtkMethodCallId);
                this._gtkNotifications.unexport();
            }

            if (this._settings) {
                this._settings.disconnect(this._settingsId);
                this._settings.run_dispose();
            }

            // TODO: Gio.IOErrorEnum: The connection is closed
            // this._monitor.close_sync(null);

            GObject.signal_handlers_destroy(this);
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * The service class for this component
 */
var Component = Listener;

