// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as NotificationDaemon from 'resource:///org/gnome/shell/ui/notificationDaemon.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIcon} from './utils.js';

const {NotificationMessage} = Number(PACKAGE_VERSION.split('.')[0]) >= 48
    ? await import('resource:///org/gnome/shell/ui/messageList.js')  // GNOME 48
    : await import('resource:///org/gnome/shell/ui/calendar.js');    // GNOME 46/47

const APP_ID = 'org.gnome.Shell.Extensions.GSConnect';
const APP_PATH = '/org/gnome/Shell/Extensions/GSConnect';


// deviceId Pattern (<device-id>|<remote-id>)
const DEVICE_REGEX = new RegExp(/^([^|]+)\|([\s\S]+)$/);

// requestReplyId Pattern (<device-id>|<remote-id>)|<reply-id>)
const REPLY_REGEX = new RegExp(/^([^|]+)\|([\s\S]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/, 'i');


/**
 * Extracted from notificationDaemon.js, as it's no longer exported
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/notificationDaemon.js#L556
 *
 * @returns {{ 'desktop-startup-id': string }} Object with ID containing current time
 */
function getPlatformData() {
    const startupId = GLib.Variant.new('s', `_TIME${global.get_current_time()}`);
    return {'desktop-startup-id': startupId};
}

// This is no longer directly exported, so we do this instead for now
const GtkNotificationDaemon = Main.notificationDaemon._gtkNotificationDaemon.constructor;


/**
 * A slightly modified Notification Banner with an entry field
 */
const NotificationBanner = GObject.registerClass({
    GTypeName: 'GSConnectNotificationBanner',
}, class NotificationBanner extends NotificationMessage {

    constructor(notification) {
        super(notification);
        if (notification.requestReplyId !== undefined)
            this._addReplyAction();
    }

    _addReplyAction() {
        if (!this._buttonBox) {
            this._buttonBox = new St.BoxLayout({
                style_class: 'notification-buttons-bin',
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
        const platformData = getPlatformData();

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
                } catch {
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
        const platformData = getPlatformData();

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
                } catch {
                    // If we fail, reset in case we can try again
                    notification._remoteClosed = false;
                }
            }
        );
    }

    /*
     * Parse the id to determine if it's a repliable notification, device
     * notification or a regular local notification
     */
    _parseNotificationId(notificationId) {
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
        return [idMatch, deviceId, requestReplyId, remoteId, localId];
    }

    /*
     * Add notification to source or update existing notification with extra
     * GsConnect information
     */
    _createNotification(notification) {
        const [idMatch, deviceId, requestReplyId, remoteId, localId] = this._parseNotificationId(notification.id);
        const cachedNotification = this._notifications[localId];

        // Check if this is a repeat
        if (cachedNotification) {
            cachedNotification.requestReplyId = requestReplyId;

            const title = notification.title;
            const body = notification.body
                ? notification.body
                : null;

            // Bail early If @notification represents an exact repeat
            if (cachedNotification.title === title &&
                cachedNotification.body === body)
                return cachedNotification;

            // If the details have changed, flag as an update
            cachedNotification.title = title;
            cachedNotification.body = body;
            cachedNotification.acknowledged = false;
            return cachedNotification;
        }

        // Device Notification
        if (idMatch) {
            notification.deviceId = deviceId;
            notification.remoteId = remoteId;
            notification.requestReplyId = requestReplyId;

            notification.connect('destroy', (notification, reason) => {
                this._closeGSConnectNotification(notification, reason);
                delete this._notifications[localId];
            });

        // Service Notification
        } else {
            notification.connect('destroy', (notification, reason) => {
                delete this._notifications[localId];
            });
        }

        this._notifications[localId] = notification;
        return notification;
    }

    /*
     * Override to control notification spawning
     */
    addNotification(notification) {
        this._notificationPending = true;

        // Fix themed icons
        if (notification.icon) {
            let gicon = notification.icon;

            if (gicon instanceof Gio.ThemedIcon) {
                gicon = getIcon(gicon.names[0]);
                notification.icon = gicon.serialize();
            }
        }

        const createdNotification = this._createNotification(notification);
        this._addNotificationToMessageTray(createdNotification);

        this._notificationPending = false;
    }

    /*
     * Reimplementation of MessageTray.addNotification to raise the usual
     * notification limit (3)
     */
    _addNotificationToMessageTray(notification) {
        if (this.notifications.includes(notification))
            return;

        while (this.notifications.length >= 10) {
            const [oldest] = this.notifications;
            oldest.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        }

        notification.connect('destroy', this._onNotificationDestroy.bind(this));
        notification.connect('notify::acknowledged', () => {
            this.countUpdated();

            // If acknowledged was set to false try to show the notification again
            if (!notification.acknowledged)
                this.emit('notification-request-banner', notification);
        });
        this.notifications.push(notification);

        this.emit('notification-added', notification);
        this.emit('notification-request-banner', notification);
    }

    createBanner(notification) {
        return new NotificationBanner(notification);
    }
});


/**
 * If there is an active GtkNotificationDaemonAppSource for GSConnect when the
 * extension is loaded, it has to be patched in place.
 */
export function patchGSConnectNotificationSource() {
    const source = Main.notificationDaemon._gtkNotificationDaemon._sources[APP_ID];

    if (source !== undefined) {
        // Patch in the subclassed methods
        source._closeGSConnectNotification = Source.prototype._closeGSConnectNotification;
        source._parseNotificationId = Source.prototype._parseNotificationId;
        source._createNotification = Source.prototype._createNotification;
        source.addNotification = Source.prototype.addNotification;
        source._addNotificationToMessageTray = Source.prototype._addNotificationToMessageTray;
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
const __ensureAppSource = GtkNotificationDaemon.prototype._ensureAppSource;

// eslint-disable-next-line func-style
const _ensureAppSource = function (appId) {
    const source = __ensureAppSource.call(this, appId);

    if (source._appId === APP_ID) {
        source._closeGSConnectNotification = Source.prototype._closeGSConnectNotification;
        source._parseNotificationId = Source.prototype._parseNotificationId;
        source._createNotification = Source.prototype._createNotification;
        source.addNotification = Source.prototype.addNotification;
        source._addNotificationToMessageTray = Source.prototype._addNotificationToMessageTray;
        source.createBanner = Source.prototype.createBanner;
    }

    return source;
};


/**
 * Update the prototype for {@link GtkNotificationDaemon}.
 */
export function patchGtkNotificationDaemon() {
    GtkNotificationDaemon.prototype._ensureAppSource = _ensureAppSource;
}


/**
 * Restore the prototype for {@link GtkNotificationDaemon}.
 */
export function unpatchGtkNotificationDaemon() {
    GtkNotificationDaemon.prototype._ensureAppSource = __ensureAppSource;
}

/**
 * We patch other Gtk notification sources so we can notify remote devices when
 * notifications have been closed locally.
 */
const _addNotification = NotificationDaemon.GtkNotificationDaemonAppSource.prototype.addNotification;

/**
 * Update the prototype for {@link NotificationDaemon.GtkNotificationDaemonAppSource}.
 */
export function patchGtkNotificationSources() {
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
        const platformData = getPlatformData();

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
                } catch {
                    // If we fail, reset in case we can try again
                    notification._remoteWithdrawn = false;
                }
            }
        );
    };

    NotificationDaemon.GtkNotificationDaemonAppSource.prototype._withdrawGSConnectNotification = _withdrawGSConnectNotification;
}


/**
 * Restore the prototype for {@link NotificationDaemon.GtkNotificationDaemonAppSource}.
 */
export function unpatchGtkNotificationSources() {
    NotificationDaemon.GtkNotificationDaemonAppSource.prototype.addNotification = _addNotification;
    delete NotificationDaemon.GtkNotificationDaemonAppSource.prototype._withdrawGSConnectNotification;
}
