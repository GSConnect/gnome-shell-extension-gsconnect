'use strict';

const GLib = imports.gi.GLib;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;


/**
 * The simplest way to control all GSConnect notifications is to create a
 * custom notification source for spawning notifications and closing device
 * notifications in sync.
 *
 * See: https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/notificationDaemon.js#L682-775
 */
class Source extends NotificationDaemon.GtkNotificationDaemonAppSource {

    _init(appId) {
        super._init(appId);
    }

    _closeDeviceNotification(id, notification, reason) {
        if (reason !== MessageTray.NotificationDestroyedReason.DISMISSED) {
            return;
        }

        // Avoid sending the request multiple times if destroy() is called on
        // the notification more than once
        if (notification._remoteClosed) {
            return;
        }

        notification._remoteClosed = true;

        this._createApp((app, error) => {
            // Bail on error and reset in case we can try again
            if (error !== null) {
                notification._remoteClosed = false;
                return;
            }

            debug(`Closing ${id}`);

            // Separate the device id and the notification id
            // TODO: maybe this should all be done in daemon.js
            let [deviceId, notifId] = id.split(/[\|](.+)/, 2);

            let target = new GLib.Variant('(osbv)', [
                `${gsconnect.app_path}/Device/${deviceId.replace(/\W+/g, '_')}`,
                'closeNotification',
                true,
                new GLib.Variant('s', notifId)
            ]);

            app.ActivateActionRemote(
                'deviceAction',
                [target],
                NotificationDaemon.getPlatformData()
            );
        });
    }

    /**
     * It's necessary to override this is to avoid remote notifications being
     * closed for reasons other than DISMISSED. Since it's the default reason
     * for ::destroy there are many places it could be emitted from.
     *
     * TODO: This is the place we'll have to handle spawning different types of
     *       notifications (eg. Telepathy/repliable notifications.
     *
     * https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/notificationDaemon.js#L736-754
     */
    addNotification(notificationId, notificationParams, showBanner) {
        this._notificationPending = true;
        let notification = this._notifications[notificationId];

        if (!notification) {
            notification = new NotificationDaemon.GtkNotificationDaemonNotification(this, notificationParams);
            notification.connect('destroy', (notification, reason) => {
                this._closeDeviceNotification(notificationId, notification, reason);
                delete this._notifications[notificationId];
            });
            this._notifications[notificationId] = notification;
        }

        if (showBanner)
            this.notify(notification);
        else
            this.pushNotification(notification);

        this._notificationPending = false;
    }

    /**
     * It's necessary to override this to lift the notification limit (3) that
     * is usually imposed on notification sources.
     *
     * See: https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/messageTray.js#L787-800
     */
    pushNotification(notification) {
        if (this.notifications.includes(notification))
            return;

        notification.connect('destroy', this._onNotificationDestroy.bind(this));
        notification.connect('acknowledged-changed', this.countUpdated.bind(this));
        this.notifications.push(notification);
        this.emit('notification-added', notification);

        this.countUpdated();
    }
}


/**
 * If there is an active GtkNotificationDaemonAppSource for GSConnect when the
 * extension is loaded, it has to be patched in place.
 */
function patchGSConnectNotificationSource() {
    let source = Main.notificationDaemon._gtkNotificationDaemon._sources[gsconnect.app_id];

    if (source !== undefined) {
        // Patch in the subclassed methods
        source._closeDeviceNotification = Source.prototype._closeDeviceNotification;
        source.addNotification = Source.prototype.addNotification;
        source.pushNotification = Source.prototype.pushNotification;

        // Connect to existing notifications
        for (let [id, notification] of Object.entries(source._notifications)) {
            notification.connect('destroy', (notification, reason) => {
                source._closeDeviceNotification(id, reason);
            });
        }
    }
}


/**
 * It's necessary to override GtkNotificationDaemon._ensureAppSource() so that
 * we can create our custom notification source when the notification is coming
 * from GSConnect.
 *
 * See: https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/notificationDaemon.js#L805-819
 */
var oldEnsureAppSource = NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource;
var newEnsureAppSource = function(appId) {
    if (this._sources[appId])
        return this._sources[appId];

    let source;

    if (appId === 'org.gnome.Shell.Extensions.GSConnect') {
        source = new Source(appId);
    } else {
        source = new NotificationDaemon.GtkNotificationDaemonAppSource(appId);
    }

    source.connect('destroy', () => {
        delete this._sources[appId];
        this._saveNotifications();
    });
    source.connect('count-updated', this._saveNotifications.bind(this));
    Main.messageTray.add(source);
    this._sources[appId] = source;
    return source;
}


/**
 * Patch/unpatch the Gtk notification daemon to spawn GSConnect sources
 */
function patchGtkNotificationDaemon() {
    NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource = newEnsureAppSource;
}


function unpatchGtkNotificationDaemon() {
    NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource = oldEnsureAppSource;
}

