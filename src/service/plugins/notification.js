'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;
const NotificationUI = imports.service.ui.notification;


var Metadata = {
    label: _('Notifications'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Notification',
    incomingCapabilities: [
        'kdeconnect.notification',
        'kdeconnect.notification.request'
    ],
    outgoingCapabilities: [
        'kdeconnect.notification',
        'kdeconnect.notification.reply',
        'kdeconnect.notification.request'
    ],
    actions: {
        withdrawNotification: {
            label: _('Cancel Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.notification']
        },
        closeNotification: {
            label: _('Close Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.notification.request']
        },
        replyNotification: {
            label: _('Reply Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('(ssa{ss})'),
            incoming: ['kdeconnect.notification'],
            outgoing: ['kdeconnect.notification.reply']
        },
        sendNotification: {
            label: _('Send Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: [],
            outgoing: ['kdeconnect.notification']
        }
    }
};


// A regex for our custom notificaiton ids
const ID_REGEX = /^(fdo|gtk)\|([^|]+)\|(.*)$/;

// A list of known SMS apps
const SMS_APPS = [
    // Popular apps that don't contain the string 'sms'
    'com.android.messaging',                    // AOSP
    'com.google.android.apps.messaging',        // Google Messages
    'com.textra',                               // Textra
    'xyz.klinker.messenger',                    // Pulse
    'com.calea.echo',                           // Mood Messenger
    'com.moez.QKSMS',                           // QKSMS
    'rpkandrodev.yaata',                        // YAATA
    'com.tencent.mm',                           // WeChat
    'com.viber.voip',                           // Viber
    'com.kakao.talk',                           // KakaoTalk
    'com.concentriclivers.mms.com.android.mms', // AOSP Clone
    'fr.slvn.mms',                              // AOSP Clone
    'com.promessage.message',                   //
    'com.htc.sense.mms',                        // HTC Messages

    // Known not to work with sms plugin
    'org.thoughtcrime.securesms',               // Signal Private Messenger
    'com.samsung.android.messaging'             // Samsung Messages
];


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notifications
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sendnotifications
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectNotificationPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'notification');

        this._sms = {};
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.notification':
                return this._handleNotification(packet);

            case 'kdeconnect.notification.request':
                return this._handleRequest(packet);

            // We don't support *incoming* replies (yet)
            case 'kdeconnect.notification.reply':
                warning('Not implemented', packet.type);
                return;

            default:
                warning('Unknown notification packet', this.device.name);
        }
    }

    connected() {
        super.connected();

        this.requestNotifications();
    }

    /**
     * Handle an incoming notification or closed report.
     */
    _handleNotification(packet) {
        // A report that a remote notification has been dismissed
        if (packet.body.hasOwnProperty('isCancel')) {
            this.device.hideNotification(packet.body.id);

        // A silent notification; process it so we can abort the transfer
        } else if (packet.body.hasOwnProperty('silent')) {
            this.silenceNotification(packet);

        // A normal, remote notification
        } else {
            this.receiveNotification(packet);
        }
    }

    /**
     * Handle an incoming request to close or list notifications.
     */
    _handleRequest(packet) {
        // A request for our notifications. This isn't implemented and would be
        // pretty hard to without communicating with GNOME Shell.
        if (packet.body.hasOwnProperty('request')) {
            return;

        // A request to close a local notification
        //
        // TODO: kdeconnect-android doesn't send these, and will instead send a
        // kdeconnect.notification packet with isCancel and an id of "0".
        //
        // For clients that do support it, we report notification ids in the
        // form "type|application-id|notification-id" so we can close it with
        // the appropriate service.
        } else if (packet.body.hasOwnProperty('cancel')) {
            let [, type, application, id] = ID_REGEX.exec(packet.body.cancel);

            switch (type) {
                case 'fdo':
                    this.service.remove_notification(parseInt(id));
                    break;

                case 'gtk':
                    this.service.remove_notification(id, application);
                    break;

                default:
                    warning('Unknown notification type', this.device.name);
            }
        }
    }

    /**
     * Check an internal id for evidence that it's from an SMS app
     *
     * @param {string} - Internal notification id
     * @return {boolean} - Whether the id has evidence it's from an SMS app
     */
    _isSms(id) {
        if (id.includes('sms')) return true;

        for (let i = 0, len = SMS_APPS.length; i < len; i++) {
            if (id.includes(SMS_APPS[i])) return true;
        }

        return false;
    }

    /**
     * Sending Notifications
     */
    async _uploadIcon(packet, icon) {
        try {
            // Normalize icon-name strings into GIcons
            if (typeof icon === 'string') {
                icon = new Gio.ThemedIcon({name: icon});
            }

            switch (true) {
                // TODO: Currently we skip icons for bluetooth connections
                case (this.device.connection_type === 'bluetooth'):
                    return this.device.sendPacket(packet);

                // GBytesIcon
                case (icon instanceof Gio.BytesIcon):
                    return this._uploadBytesIcon(packet, icon.get_bytes());

                // GFileIcon
                case (icon instanceof Gio.FileIcon):
                    return this._uploadFileIcon(packet, icon.get_file());

                // GThemedIcon
                case (icon instanceof Gio.ThemedIcon):
                    return this._uploadThemedIcon(packet, icon);

                default:
                    return this.device.sendPacket(packet);
            }
        } catch (e) {
            logError(e);
            return this.device.sendPacket(packet);
        }
    }

    /**
     * A function for uploading named icons from a GLib.Bytes object.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {GLib.Bytes} bytes - The themed icon name
     */
    _uploadBytesIcon(packet, bytes) {
        return this._uploadIconStream(
            packet,
            Gio.MemoryInputStream.new_from_bytes(bytes),
            bytes.get_size()
        );
    }

    /**
     * A function for uploading icons as Gio.File objects
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.File} file - A Gio.File object for the icon
     */
    async _uploadFileIcon(packet, file) {
        let stream;

        try {
            stream = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                    try {
                        resolve(file.read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            return this._uploadIconStream(
                packet,
                stream,
                file.query_info('standard::size', 0, null).get_size()
            );
        } catch (e) {
            logError(e);
            this.device.sendPacket(packet);
        }
    }

    /**
     * A function for uploading GThemedIcons
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.ThemedIcon} file - The GIcon to upload
     */
    _uploadThemedIcon(packet, icon) {
        let theme = Gtk.IconTheme.get_default();

        for (let name of icon.names) {
            // kdeconnect-android doesn't support SVGs so find the largest other
            let info = theme.lookup_icon(
                name,
                Math.max.apply(null, theme.get_icon_sizes(name)),
                Gtk.IconLookupFlags.NO_SVG
            );

            // Send the first icon we find from the options
            if (info) {
                return this._uploadFileIcon(
                    packet,
                    Gio.File.new_for_path(info.get_filename())
                );
            }
        }

        // Fallback to icon-less notification
        return this.device.sendPacket(packet);
    }

    /**
     * All icon types end up being uploaded in this function.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.InputStream} stream - A stream to read the icon bytes from
     * @param {number} size - Size of the icon in bytes
     */
    async _uploadIconStream(packet, stream, size) {
        try {
            let transfer = this.device.createTransfer({
                input_stream: stream,
                size: size
            });

            let success = await transfer.upload(packet);

            if (!success) {
                this.device.sendPacket(packet);
            }
        } catch (e) {
            debug(e);
            this.device.sendPacket(packet);
        }
    }

    /**
     * This is called by the notification listener.
     * See Notification.Listener._sendNotification()
     */
    async sendNotification(notif) {
        try {
            // Sending notifications is forbidden
            if (!this.settings.get_boolean('send-notifications')) {
                return;
            }

            debug(`(${notif.appName}) ${notif.title}: ${notif.text}`);

            // TODO: revisit application notification settings
            let applications = JSON.parse(this.settings.get_string('applications'));

            // An unknown application
            if (!applications.hasOwnProperty(notif.appName)) {
                applications[notif.appName] = {
                    iconName: 'system-run-symbolic',
                    enabled: true
                };

                // Only catch icons for strings and GThemedIcon
                if (typeof notif.icon === 'string') {
                    applications[notif.appName].iconName = notif.icon;
                } else if (notif.icon instanceof Gio.ThemedIcon) {
                    applications[notif.appName].iconName = notif.icon.names[0];
                }

                this.settings.set_string(
                    'applications',
                    JSON.stringify(applications)
                );
            }

            // An enabled application
            if (applications[notif.appName].enabled) {
                let icon = notif.icon || null;
                delete notif.icon;

                let packet = {
                    id: 0,
                    type: 'kdeconnect.notification',
                    body: notif
                };

                await this._uploadIcon(packet, icon);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Receiving Notifications
     */
    async _downloadIcon(packet) {
        let file, path, stream, success, transfer;

        try {
            if (!packet.payloadTransferInfo) {
                return null;
            }

            // Save the file in the global cache
            path = GLib.build_filenamev([
                gsconnect.cachedir,
                packet.body.payloadHash || `${Date.now()}`
            ]);
            file = Gio.File.new_for_path(path);

            // Check if we've already downloaded this icon
            if (file.query_exists(null)) {
                return new Gio.FileIcon({file: file});
            }

            // Open the file
            stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 2, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Download the icon
            transfer = this.device.createTransfer(Object.assign({
                output_stream: stream,
                size: packet.payloadSize
            }, packet.payloadTransferInfo));

            success = await transfer.download(
                packet.payloadTransferInfo.port || packet.payloadTransferInfo.uuid
            );

            // Return the icon if successful, delete on failure
            if (success) {
                return new Gio.FileIcon({file: file});
            }

            await new Promise((resolve, reject) => {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                    try {
                        file.delete_finish(res);
                    } catch (e) {
                    }

                    resolve();
                });
            });

            return null;
        } catch (e) {
            debug(e, this.device.name);
            return null;
        }
    }

    /**
     * Receive an incoming notification
     *
     * @param {kdeconnect.notification} packet - The notification packet
     */
    async receiveNotification(packet) {
        try {
            // Set defaults
            let action = null;
            let id = packet.body.id;
            let title = packet.body.appName;
            let body = `${packet.body.title}: ${packet.body.text}`;
            let icon = await this._downloadIcon(packet);

            // Check if this is a repliable notification
            if (packet.body.requestReplyId) {
                id = `${packet.body.id}|${packet.body.requestReplyId}`;
                action = {
                    name: 'replyNotification',
                    parameter: new GLib.Variant('(ssa{ss})', [
                        packet.body.requestReplyId,
                        '',
                        {
                            appName: packet.body.appName,
                            title: packet.body.title,
                            text: packet.body.text
                        }
                    ])
                };
            }

            switch (true) {
                // Special case for Missed Calls
                case packet.body.id.includes('MissedCall'):
                    title = packet.body.title;
                    body = packet.body.text;
                    icon = icon || new Gio.ThemedIcon({name: 'call-missed-symbolic'});
                    break;

                // Special case for SMS notifications
                case this._isSms(packet.body.id):
                    title = packet.body.title;
                    body = packet.body.text;
                    action = {
                        name: 'replySms',
                        parameter: new GLib.Variant('s', packet.body.title)
                    };
                    icon = icon || new Gio.ThemedIcon({name: 'sms-symbolic'});

                    this._sms[packet.body.ticker] = packet.body.id;
                    break;

                // Ignore 'appName' if it's the same as 'title'
                case (packet.body.appName === packet.body.title):
                    body = packet.body.text;
                    break;
            }

            // If we still don't have an icon use the device icon
            icon = icon || new Gio.ThemedIcon({name: this.device.icon_name});

            // Show the notification
            this.device.showNotification({
                id: id,
                title: title,
                body: body,
                icon: icon,
                action: action
            });
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Handle a "silent" notification
     *
     * @param {kdeconnect.notification} packet - The notification packet
     */
    async silenceNotification(packet) {
        try {
            if (!packet.payloadTransferInfo) {
                return null;
            }

            let transfer = this.device.createTransfer({
                output_stream: null,
                size: packet.payloadSize
            });

            // Since we've passed a bogus stream, this will abort the transfer
            await transfer.download(
                packet.payloadTransferInfo.port || packet.payloadTransferInfo.uuid
            );
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Report that a local notification has been closed/dismissed.
     * TODO: kdeconnect-android doesn't handle incoming isCancel packets.
     *
     * @param {string} id - The local notification id
     */
    withdrawNotification(id) {
        debug(id);

        this.device.sendPacket({
            type: 'kdeconnect.notification',
            body: {
                isCancel: true,
                id: id
            }
        });
    }

    /**
     * Close a remote notification.
     * TODO: ignore local notifications
     *
     * @param {string} id - The remote notification id
     */
    closeNotification(id) {
        debug(id);

        let tickerId = this._sms[id];

        if (tickerId) {
            delete this._sms[id];
            id = tickerId;
        }

        this.device.sendPacket({
            type: 'kdeconnect.notification.request',
            body: {cancel: id}
        });
    }

    /**
     * Reply to a notification sent with a requestReplyId UUID
     *
     * @param {string} uuid - The requestReplyId for the repliable notification
     * @param {string} message - The message to reply with
     * @param {object} notification - The original notification
     */
    replyNotification(uuid, message, notification) {
        debug([uuid, message]);

        // If the message has no content, we're being asked to open the dialog
        if (message.length === 0) {
            new NotificationUI.Dialog({
                device: this.device,
                uuid: uuid,
                notification: notification
            });
        } else {
            this.device.sendPacket({
                type: 'kdeconnect.notification.reply',
                body: {
                    requestReplyId: uuid,
                    message: message
                }
            });
        }
    }

    /**
     * Request the remote notifications be sent
     */
    requestNotifications() {
        this.device.sendPacket({
            type: 'kdeconnect.notification.request',
            body: {request: true}
        });
    }
});

