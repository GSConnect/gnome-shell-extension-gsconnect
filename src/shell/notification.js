'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;

const Extension = imports.misc.extensionUtils.getCurrentExtension();

// eslint-disable-next-line no-redeclare
const _ = Extension._;
const APP_ID = 'org.gnome.Shell.Extensions.GSConnect';
const APP_PATH = '/org/gnome/Shell/Extensions/GSConnect';


// deviceId Pattern (<device-id>|<remote-id>)
const DEVICE_REGEX = new RegExp(/^([^|]+)\|([\s\S]+)$/);

// requestReplyId Pattern (<device-id>|<remote-id>)|<reply-id>)
const REPLY_REGEX = new RegExp(/^([^|]+)\|([\s\S]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/, 'i');


/**
 * A slightly modified Notification Banner with an entry field
 */
const NotificationBanner = GObject.registerClass({
    GTypeName: 'GSConnectNotificationBanner',
}, class NotificationBanner extends MessageTray.NotificationBanner {

    _init(notification) {
        super._init(notification);

        if (notification.requestReplyId !== undefined)
            this._addReplyAction();
    }

    _addReplyAction() {
        if (!this._buttonBox) {
            this._buttonBox = new St.BoxLayout({
                style_class: 'notification-actions',
                x_expand: true,
            });
            this.setActionArea(this._buttonBox);
            global.focus_manager.add_group(this._buttonBox);
        }

        // Reply Button
        const button = new St.Button({
            style_class: 'notification-button',
            label: _('Reply'),
            x_expand: true,
            can_focus: true,
        });

        button.connect(
            'clicked',
            this._onEntryRequested.bind(this)
        );

        this._buttonBox.add_child(button);

        // Reply Entry
        this._replyEntry = new St.Entry({
            can_focus: true,
            hint_text: _('Type a message'),
            style_class: 'chat-response',
            x_expand: true,
            visible: false,
        });

        this._buttonBox.add_child(this._replyEntry);
    }

    _onEntryRequested(button) {
        this.focused = true;

        for (const child of this._buttonBox.get_children())
            child.visible = (child === this._replyEntry);

        // Release the notification focus with the entry focus
        this._replyEntry.connect(
            'key-focus-out',
            this._onEntryDismissed.bind(this)
        );

        this._replyEntry.clutter_text.connect(
            'activate',
            this._onEntryActivated.bind(this)
        );

        this._replyEntry.grab_key_focus();
    }

    _onEntryDismissed(entry) {
        this.focused = false;
        this.emit('unfocused');
    }

    _onEntryActivated(clutter_text) {
        // Refuse to send empty replies
        if (clutter_text.text === '')
            return;

        // Copy the text, then clear the entry
        const text = clutter_text.text;
        clutter_text.text = '';

        const {deviceId, requestReplyId} = this.notification;

        const target = new GLib.Variant('(ssbv)', [
            deviceId,
            'replyNotification',
            true,
            new GLib.Variant('(ssa{ss})', [requestReplyId, text, {}]),
        ]);
        const platformData = NotificationDaemon.getPlatformData();

        Gio.DBus.session.call(
            APP_ID,
            APP_PATH,
            'org.freedesktop.Application',
            'ActivateAction',
            GLib.Variant.new('(sava{sv})', ['device', [target], platformData]),
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            null,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    // Silence errors
                }
            }
        );

        this.close();
    }
});


/**
 * A custom notification source for spawning notifications and closing device
 * notifications. This source isn't actually used, but it's methods are patched
 * into existing sources.
 */
const Source = GObject.registerClass({
    GTypeName: 'GSConnectNotificationSource',
}, class Source extends NotificationDaemon.GtkNotificationDaemonAppSource {

    _closeGSConnectNotification(notification, reason) {
        if (reason !== MessageTray.NotificationDestroyedReason.DISMISSED)
            return;

        // Avoid sending the request multiple times
        if (notification._remoteClosed || notification.remoteId === undefined)
            return;

        notification._remoteClosed = true;

        const target = new GLib.Variant('(ssbv)', [
            notification.deviceId,
            'closeNotification',
            true,
            new GLib.Variant('s', notification.remoteId),
        ]);
        const platformData = NotificationDaemon.getPlatformData();

        Gio.DBus.session.call(
            APP_ID,
            APP_PATH,
            'org.freedesktop.Application',
            'ActivateAction',
            GLib.Variant.new('(sava{sv})', ['device', [target], platformData]),
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            null,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    // If we fail, reset in case we can try again
                    notification._remoteClosed = false;
                }
            }
        );
    }

    /*
     * Override to control notification spawning
     */
    addNotification(notificationId, notificationParams, showBanner) {
        this._notificationPending = true;

        // Parse the id to determine if it's a repliable notification, device
        // notification or a regular local notification
        let idMatch, deviceId, requestReplyId, remoteId, localId;

        if ((idMatch = REPLY_REGEX.exec(notificationId))) {
            [, deviceId, remoteId, requestReplyId] = idMatch;
            localId = `${deviceId}|${remoteId}`;

        } else if ((idMatch = DEVICE_REGEX.exec(notificationId))) {
            [, deviceId, remoteId] = idMatch;
            localId = `${deviceId}|${remoteId}`;

        } else {
            localId = notificationId;
        }

        // Fix themed icons
        if (notificationParams.icon) {
            let gicon = Gio.Icon.deserialize(notificationParams.icon);

            if (gicon instanceof Gio.ThemedIcon) {
                gicon = Extension.getIcon(gicon.names[0]);
                notificationParams.icon = gicon.serialize();
            }
        }

        let notification = this._notifications[localId];

        // Check if this is a repeat
        if (notification) {
            notification.requestReplyId = requestReplyId;

            // Bail early If @notificationParams represents an exact repeat
            const title = notificationParams.title.unpack();
            const body = notificationParams.body
                ? notificationParams.body.unpack()
                : null;

            if (notification.title === title &&
                notification.bannerBodyText === body) {
                this._notificationPending = false;
                return;
            }

            notification.title = title;
            notification.bannerBodyText = body;

        // Device Notification
        } else if (idMatch) {
            notification = this._createNotification(notificationParams);

            notification.deviceId = deviceId;
            notification.remoteId = remoteId;
            notification.requestReplyId = requestReplyId;

            notification.connect('destroy', (notification, reason) => {
                this._closeGSConnectNotification(notification, reason);
                delete this._notifications[localId];
            });

            this._notifications[localId] = notification;

        // Service Notification
        } else {
            notification = this._createNotification(notificationParams);
            notification.connect('destroy', (notification, reason) => {
                delete this._notifications[localId];
            });
            this._notifications[localId] = notification;
        }

        if (showBanner)
            this.showNotification(notification);
        else
            this.pushNotification(notification);

        this._notificationPending = false;
    }

    /*
     * Override to raise the usual notification limit (3)
     */
    pushNotification(notification) {
        if (this.notifications.includes(notification))
            return;

        while (this.notifications.length >= 10)
            this.notifications.shift().destroy(MessageTray.NotificationDestroyedReason.EXPIRED);

        notification.connect('destroy', this._onNotificationDestroy.bind(this));
        notification.connect('notify::acknowledged', this.countUpdated.bind(this));
        this.notifications.push(notification);
        this.emit('notification-added', notification);

        this.countUpdated();
    }

    createBanner(notification) {
        return new NotificationBanner(notification);
    }
});


/**
 * If there is an active GtkNotificationDaemonAppSource for GSConnect when the
 * extension is loaded, it has to be patched in place.
 */
function patchGSConnectNotificationSource() {
    const source = Main.notificationDaemon._gtkNotificationDaemon._sources[APP_ID];

    if (source !== undefined) {
        // Patch in the subclassed methods
        source._closeGSConnectNotification = Source.prototype._closeGSConnectNotification;
        source.addNotification = Source.prototype.addNotification;
        source.pushNotification = Source.prototype.pushNotification;
        source.createBanner = Source.prototype.createBanner;

        // Connect to existing notifications
        for (const notification of Object.values(source._notifications)) {

            const _id = notification.connect('destroy', (notification, reason) => {
                source._closeGSConnectNotification(notification, reason);
                notification.disconnect(_id);
            });
        }
    }
}


/**
 * Wrap GtkNotificationDaemon._ensureAppSource() to patch GSConnect's app source
 * https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/notificationDaemon.js#L742-755
 */
const __ensureAppSource = NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource;

// eslint-disable-next-line func-style
const _ensureAppSource = function (appId) {
    const source = __ensureAppSource.call(this, appId);

    if (source._appId === APP_ID) {
        source._closeGSConnectNotification = Source.prototype._closeGSConnectNotification;
        source.addNotification = Source.prototype.addNotification;
        source.pushNotification = Source.prototype.pushNotification;
        source.createBanner = Source.prototype.createBanner;
    }

    return source;
};


function patchGtkNotificationDaemon() {
    NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource = _ensureAppSource;
}


function unpatchGtkNotificationDaemon() {
    NotificationDaemon.GtkNotificationDaemon.prototype._ensureAppSource = __ensureAppSource;
}

/**
 * We patch other Gtk notification sources so we can notify remote devices when
 * notifications have been closed locally.
 */
const _addNotification = NotificationDaemon.GtkNotificationDaemonAppSource.prototype.addNotification;

function patchGtkNotificationSources() {
    // This should diverge as little as possible from the original
    // eslint-disable-next-line func-style
    const addNotification = function (notificationId, notificationParams, showBanner) {
        this._notificationPending = true;

        if (this._notifications[notificationId])
            this._notifications[notificationId].destroy(MessageTray.NotificationDestroyedReason.REPLACED);

        const notification = this._createNotification(notificationParams);
        notification.connect('destroy', (notification, reason) => {
            this._withdrawGSConnectNotification(notification, reason);
            delete this._notifications[notificationId];
        });
        this._notifications[notificationId] = notification;

        if (showBanner)
            this.showNotification(notification);
        else
            this.pushNotification(notification);

        this._notificationPending = false;
    };

    // eslint-disable-next-line func-style
    const _withdrawGSConnectNotification = function (id, notification, reason) {
        if (reason !== MessageTray.NotificationDestroyedReason.DISMISSED)
            return;

        // Avoid sending the request multiple times
        if (notification._remoteWithdrawn)
            return;

        notification._remoteWithdrawn = true;

        // Recreate the notification id as it would've been sent
        const target = new GLib.Variant('(ssbv)', [
            '*',
            'withdrawNotification',
            true,
            new GLib.Variant('s', `gtk|${this._appId}|${id}`),
        ]);
        const platformData = NotificationDaemon.getPlatformData();

        Gio.DBus.session.call(
            APP_ID,
            APP_PATH,
            'org.freedesktop.Application',
            'ActivateAction',
            GLib.Variant.new('(sava{sv})', ['device', [target], platformData]),
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            null,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    // If we fail, reset in case we can try again
                    notification._remoteWithdrawn = false;
                }
            }
        );
    };

    NotificationDaemon.GtkNotificationDaemonAppSource.prototype.addNotification = addNotification;
    NotificationDaemon.GtkNotificationDaemonAppSource.prototype._withdrawGSConnectNotification = _withdrawGSConnectNotification;
}


function unpatchGtkNotificationSources() {
    NotificationDaemon.GtkNotificationDaemonAppSource.prototype.addNotification = _addNotification;
    delete NotificationDaemon.GtkNotificationDaemonAppSource.prototype._withdrawGSConnectNotification;
}

