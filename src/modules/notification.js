'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const DBus = imports.modules.dbus;


/**
 * A class for snooping Freedesktop (libnotify) and Gtk (GNotification)
 * notifications and forwarding them to supporting devices.
 */
var Listener = class Listener {
    constructor() {
        this.application = Gio.Application.get_default();

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

        // Start the listener
        this._initConnection();
    }

    get applications() {
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
    _createConnection() {
        return new Promise((resolve, reject) => {
            Gio.DBusConnection.new_for_address(
                Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null),
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT,
                null,
                null,
                (connection, res) => {
                    try {
                        this._connection = Gio.DBusConnection.new_for_address_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );

        });
    }

    /**
     * Introduce the monitoring connection to DBus
     */
    _helloConnection() {
        return new Promise((resolve, reject) => {
            this._connection.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'Hello',
                null,
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

    /**
     * Export interfaces for proxying notifications and become a monitor
     */
    _monitorConnection() {
        return new Promise((resolve, reject) => {
            // libnotify Interface
            this._fdoNotifications = new DBus.Interface({
                g_connection: this._connection,
                g_instance: this,
                g_interface_info: gsconnect.dbusinfo.lookup_interface(
                    'org.freedesktop.Notifications'
                ),
                g_object_path: '/org/freedesktop/Notifications'
            });

            let fdoMatch = 'interface=\'org.freedesktop.Notifications\',' +
                           'member=\'Notify\',' +
                           'type=\'method_call\'';

            // GNotification Interface
            this._gtkNotifications = new DBus.Interface({
                g_connection: this._connection,
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
            this._connection.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus.Monitoring',
                'BecomeMonitor',
                new GLib.Variant('(asu)', [[fdoMatch, gtkMatch], 0]),
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

    async _initConnection() {
        try {
            await this._createConnection();
            await this._helloConnection();
            await this._monitorConnection();
        } catch (e) {
            logError(e, 'Notification Listener');
        }
    }

    _sendNotification(notif) {
        debug(notif);

        // Check if notifications are disabled in desktop settings
        let appSettings = this.applications[notif.appName];

        if (appSettings && !appSettings.get_boolean('enable')) {
            return;
        }

        // Remove empty icon
        // TODO: recheck this
        if (notif.icon === null) {
            delete notif.icon;
        }

        // Send the notification to each supporting device
        let variant = GLib.Variant.full_pack(notif);

        for (let device of this.application._devices.values()) {
            device.activate_action('sendNotification', variant);
        }
    }

    async Notify(appName, replacesId, iconName, summary, body, actions, hints, timeout) {
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
                isClearable: (replacesId !== '0'),
                icon: iconName
            });
        } catch (e) {
            logError(e);
        }
    }

    /**
     * org.gtk.Notifications.AddNotification
     *
     * @param {string} application - The application ID
     * @param {string} id - The notification ID
     * @param {object} notification - The notification properties
     * @param {string} notification.title - The notification title
     * @param {string} notification.body - The notification body
     * @param {Gio.Icon (serialized)} notification.icon - The notification icon
     */
    async AddNotification(application, id, notification) {
        try {
            // Ignore our own notifications
            if (application === 'org.gnome.Shell.Extensions.GSConnect') {
                return;
            }

            // KDE Connect notifications packets are in the form of libnotify so
            // we have to reformat GNotification properties
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
                id: `gtk|${application}|${id}`,
                title: notification.title,
                text: notification.body,
                ticker: `${notification.title}: ${notification.body}`,
                isClearable: true,
                icon: icon
            });
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        try {
            this._settings.disconnect(this._settingsId);
            this._fdoNotifications.destroy();
            this._gtkNotifications.destroy();
            this._connection.close_sync(null);
        } catch (e) {
            logWarning(e);
        }
    }
};

