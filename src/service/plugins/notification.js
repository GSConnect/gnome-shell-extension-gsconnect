'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Notifications'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Notification',
    incomingCapabilities: [
        'kdeconnect.notification',
        'kdeconnect.notification.request'
    ],
    outgoingCapabilities: [
        'kdeconnect.notification',
        // TODO: not supported
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
        sendNotification: {
            label: _('Send Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: [],
            outgoing: ['kdeconnect.notification']
        }
    }
};


var ID_REGEX = /^(fdo|gtk)\|([^\|]+)\|(.*)$/;


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

        this.contacts = this.service.contacts;

        // Duplicate tracking of telephony notifications
        this._duplicates = new Map();

        this.settings.bind(
            'send-notifications',
            this.device.lookup_action('sendNotification'),
            'enabled',
            Gio.SettingsBindFlags.GET
        );
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.notification':
                return this._handleNotification(packet);

            case 'kdeconnect.notification.request':
                return this._handleRequest(packet);

            case 'kdeconnect.notification.reply':
                logWarning('Not implemented', packet.type);
                return;

            default:
                logWarning('Unknown notification packet', this.device.name);
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

        // A remote notification (that hasn't been marked silent)
        } else if (!packet.body.hasOwnProperty('silent')) {
            this.receiveNotification(packet);
        }
    }

    /**
     * Handle an incoming request to close or list notifications.
     */
    _handleRequest(packet) {
        // A request for our notifications. This isn't implemented and would be
        // pretty hard to without communicating with Gnome Shell.
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
            let [m, type, application, id] = ID_REGEX.exec(packet.body.cancel);

            switch (type) {
                case 'fdo':
                    this.service.remove_notification(parseInt(id));
                    break;

                case 'gtk':
                    this.service.remove_notification(id, application);
                    break;

                default:
                    logWarning('Unknown notification type', this.device.name);
            }
        }
    }

    /**
     * Mark a notification to be closed if received (not shown locally and
     * closed remotely)
     *
     * @param {string} ticker - The notification's expected content
     */
    closeDuplicate(ticker) {
        debug(ticker);

        if (this._duplicates.has(ticker)) {
            let duplicate = this._duplicates.get(ticker);

            if (duplicate.id) {
                this.closeNotification(duplicate.id);
                this._duplicates.delete(ticker);
            } else {
                duplicate.close = true;
            }
        } else {
            this._duplicates.set(ticker, { close: true });
        }
    }

    /**
     * Mark a notification to be silenced if received (not shown locally)
     *
     * @param {string} ticker - The notification's expected content
     */
    silenceDuplicate(ticker) {
        debug(ticker);

        if (this._duplicates.has(ticker)) {
            this._duplicates.get(ticker).silence = true;
        } else {
            this._duplicates.set(ticker, { silence: true });
        }
    }

    /**
     * Sending Notifications
     */
    async _uploadIcon(packet, icon) {
        try {
            // TODO: Currently we skip icons for bluetooth connections
            if (this.device.connection_type === 'bluetooth') {
                return this.device.sendPacket(packet);
            }

            // Normalize icon-name strings into GIcons
            if (typeof icon === 'string') {
                icon = new Gio.ThemedIcon({ name: icon });
            }

            switch (true) {
                // GBytesIcon
                case (icon instanceof Gio.BytesIcon):
                    let bytes = icon.get_bytes();
                    return this._uploadBytesIcon(packet, bytes);
                    break;

                // GFileIcon
                case (icon instanceof Gio.FileIcon):
                    let file = icon.get_file();
                    return this._uploadFileIcon(packet, file);
                    break;

                // GThemedIcon
                case (icon instanceof Gio.ThemedIcon):
                    return this._uploadThemedIcon(packet, icon);
                    break;

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
        let icon = null;
        let success, transfer;

        try {
            if (!packet.hasOwnProperty('payloadTransferInfo')) {
                return null;
            }

            let path = GLib.build_filenamev([
                gsconnect.cachedir,
                packet.body.payloadHash || `${Date.now()}`
            ]);
            let file = Gio.File.new_for_path(path);

            let stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 2, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            let transfer = this.device.createTransfer({
                output_stream: stream,
                size: packet.payloadSize
            });

            if (packet.payloadTransferInfo.hasOwnProperty('port')) {
                success = await transfer.download(packet.payloadTransferInfo.port);

            // TODO: Skip icons for bluetooth since there's no action to disable
            } else if (packet.payloadTransferInfo.hasOwnProperty('uuid')) {
                transfer.close();
                return null;
            }

            if (success) {
                icon = new Gio.FileIcon({ file: file });
            }
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            return icon;
        }
    }

    /**
     * This mimics _parseEvent() from the telephony plugin, updates the contact
     * avatar (if necessary), then calls either callNotification() from the
     * telephony plugin or smsNotification() from the sms plugin.
     *
     * @param {object} notif - The body of a kdeconnect.notification packet
     * @param {object} contact - A contact object
     * @param {Gio.Icon|null} icon - The notification icon (nullable)
     * @param {string} type - The event type; either "missedCall" or "sms"
     */
    async _telephonyNotification(notif, contact, icon, type) {
        try {
            // Fabricate a message packet from what we know
            // TODO: revisit created values
            let message = {
                contactName: contact.name,
                _id: 0,
                thread_id: 0,
                address: contact.numbers[0].number,
                date: parseInt(notif.time),
                event: type,
                read: 0,    // Sms.MessageStatus.UNREAD
                type: 2     // Sms.MessageType.IN
            };

            // Update contact avatar
            if (icon instanceof Gio.BytesIcon) {
                contact = await this.service.contacts.setAvatarPath(
                    contact.id,
                    icon.file.get_path()
                );
            }

            if (message.event === 'sms') {
                message.body = notif.text;
                let sms = imports.service.plugins.sms.Plugin;
                sms.prototype.smsNotification.call(this, contact, message);
            } else if (message.event === 'missedCall') {
                // TRANSLATORS: eg. Missed call from John Smith
                message.body = _('Missed call from %s').format(contact.name);
                let telephony = imports.service.plugins.telephony.Plugin;
                telephony.prototype.callNotification.call(this, contact, message);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Receive an incoming notification, either handling it as a duplicate of a
     * telephony notification or displaying to the user.
     *
     * @param {kdeconnect.notification} packet - The notification packet
     */
    async receiveNotification(packet) {
        try {
            //
            let id = packet.body.id;
            let body, contact, title;
            let icon = await this._downloadIcon(packet);

            // Check if this is a sms/telephony notification
            let isMissedCall = packet.body.id.includes('MissedCall');
            let isSms = packet.body.id.includes('sms');

            // Check if it's been marked as a duplicate
            let duplicate = this._duplicates.get(packet.body.ticker);

            if ((isMissedCall || isSms) && duplicate) {
                // We've been asked to close this
                if (duplicate.close) {
                    this.closeNotification(packet.body.id);
                    this._duplicates.delete(packet.body.ticker);
                    return;
                // We've been asked to silence this, so just track the ID
                } else if (duplicate.silence) {
                    duplicate.id = packet.body.id;
                    return;
                }
            }

            // If it's a telephony event not marked as a duplicate...
            if (isMissedCall || isSms) {
                // Track the id so it can be closed with a telephony notification.
                this._duplicates.set(packet.body.ticker, { id: packet.body.id });

                // Look for a contact with a single phone number, but don't create
                // one since we only get a number or a name
                contact = this.contacts.query({
                    name: (isSms) ? packet.body.title : packet.body.text,
                    number: (isSms) ? packet.body.title : packet.body.text
                });

                // If found, send this using a telephony plugin method
                if (contact) {
                    return this._telephonyNotification(
                        packet.body,
                        contact,
                        icon,
                        (isMissedCall) ? 'missedCall' : 'sms'
                    );
                }
            }

            switch (true) {
                // Emulate a 'missedCall' notification
                case isMissedCall:
                    id = packet.body.ticker;
                    title = packet.body.text;
                    body = _('Missed call from %s').format(packet.body.text);
                    break;

                // Emulate an 'sms' notification
                case isSms:
                    id = packet.body.ticker;
                    title = packet.body.title;
                    body = packet.body.text;
                    break;

                // Ignore 'appName' if it's the same as 'title'
                case (packet.body.appName === packet.body.title):
                    title = packet.body.title;
                    body = packet.body.text;
                    break;

                // Otherwise use the appName as the title
                default:
                    title = packet.body.appName;
                    body = packet.body.ticker;
            }

            // If we don't have a payload icon, fallback on notification type,
            // appName then device type
            if (!icon) {
                if (isMissedCall) {
                    icon = new Gio.ThemedIcon({ name: 'call-missed-symbolic' });
                } else if (isSms) {
                    icon = new Gio.ThemedIcon({ name: 'sms-symbolic' });
                } else {
                    icon = new Gio.ThemedIcon({
                        names: [
                            packet.body.appName.toLowerCase().replace(' ', '-'),
                            `${this.device.icon_name}`
                        ]
                    });
                }
            }

            this.device.showNotification({
                id: id,
                title: title,
                body: body,
                icon: icon
            });
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Report that a local notification has been closed/dismissed.
     * TODO: kdeconnect-android doesn't handle incoming isCancel packets.
     *
     * @param {string} id - The local notification id
     */
    withdrawNotification(id) {
        debug(id)

        this.device.sendPacket({
            id: 0,
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
        debug(id)

        // If we're closing a duplicate, get the real ID first
        let duplicate = this._duplicates.get(id);

        if (duplicate && duplicate.hasOwnProperty('id')) {
            this._duplicates.delete(id);
            id = duplicate.id;
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.request',
            body: { cancel: id }
        });
    }

    /**
     * Reply to a notification sent with a requestReplyId UUID
     * TODO: this is untested and not used yet
     *
     * @param {string} uuid - The requestReplyId for the repliable notification
     * @param {string} message - The message to reply with
     */
    replyNotification(uuid, message) {
        debug(arguments);

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.reply',
            body: {
                requestReplyId: uuid,
                message: message
            }
        });
    }

    /**
     * Request the remote notifications be sent
     */
    requestNotifications() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.request',
            body: { request: true }
        });
    }
});

