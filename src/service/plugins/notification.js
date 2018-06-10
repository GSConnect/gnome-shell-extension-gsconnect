'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Contacts = imports.modules.contacts;
const Lan = imports.service.lan;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Notification',
    incomingCapabilities: ['kdeconnect.notification', 'kdeconnect.notification.request'],
    outgoingCapabilities: ['kdeconnect.notification', 'kdeconnect.notification.reply', 'kdeconnect.notification.request'],
    actions: {
        closeNotification: {
            summary: _('Close Notification'),
            description: _('Close a remote notification by Id'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.notification.request']
        },
        sendNotification: {
            summary: _('Send Notification'),
            description: _('Display a local notification remotely'),
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
 *
 * Incoming Notifications
 *
 *  {
 *      id: 1517817309016,
 *      type: 'kdeconnect.notification',
 *      body: {
 *          payloadHash: {String} MD5 Hash of payload data
 *                                (eg. '85ac3d1f77feb592f38dff6ae4f843e1'),
 *          requestReplyId: {String} UUID for repliable notifications aka
 *                                   Quick Reply (eg. '91bce2ab-873f-4056-8e91-16fd2f5781ec'),
 *          id: {String} The remote notification's Id
 *                       (eg. '0|com.google.android.apps.messaging|0|com.google.android.apps.messaging:sms:22|10109'),
 *          appName: {String} The application name (eg. 'Messages'),
 *          isClearable: {Boolean} Whether the notification can be closed,
 *          ticker: {String} Usually <title> and <text> joined with ': '. For
 *                           SMS it's '<contactName|phoneNumber>: <messageBody>',
 *          title: {String} Notification title, or <contactName|phoneNumber> for SMS,
 *          text: {String} Notification body, or <messageBody> for SMS,
 *          time: {String} String of epoch microseconds the notification
 *                         was *posted* (eg. '1517817308985'); this resets when
 *                         an Android device resets.
 *      },
 *      'payloadSize': {Number} Payload size in bytes,
 *      'payloadTransferInfo': {
 *          'port': {Number} Port number between 1739-1764 for transfer
 *      }
 *  }
 *
 *
 * TODO: consider allowing clients to handle notifications/use signals
 *       make local notifications closeable (serial/reply_serial)
 *       requestReplyId {string} - a UUID for replying (?)
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectNotificationPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'notification');

        this.contacts = Contacts.getStore();
        this._duplicates = new Map();

        // Request remote notifications (if permitted)
        this.requestNotifications();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.notification':
                return this._handleNotification(packet);

            case 'kdeconnect.notification.request':
                return this._handleRequest(packet);

            default:
                logWarning('Unknown notification packet', this.device.name);
        }
    }

    /**
     * Handle an incoming notification or closed report.
     */
    _handleNotification(packet) {
        // A report that a remote notification has been dismissed
        if (packet.body.hasOwnProperty('isCancel')) {
            this.device.withdraw_notification(packet.body.id);

        // A notification with an icon
        } else if (packet.hasOwnProperty('payloadSize')) {
            this._downloadIcon(packet).then(icon => {
                return this.receiveNotification(packet, icon);
            }).catch(e => {
                debug(e);
                this.receiveNotification(packet);
            });

        // A notification without an icon
        } else {
            this.receiveNotification(packet);
        }
    }

    /**
     * Handle an incoming request to close or list notifications.
     */
    _handleRequest(packet) {
        // A request for our notifications. This isnt implemented and would be
        // pretty hard to without somehow communicating with Gnome Shell and
        // tallying all it's notifications.
        if (packet.body.hasOwnProperty('request')) {
            return;

        // A request to close a local notification
        //
        // TODO: kdeconnect-android doesn't send these, and will instead send a
        // kdeconnect.notification packet with isCancel and an id of "0". Other
        // than GSConnect, clients might only support uint32 ids anyways since
        // kdeconnect-kde only explicitly supports libnotify.
        //
        // For clients that do support it, we report notification ids in the
        // form "type|application-id|notification-id" so we can close it with
        // the appropriate service.
        } else if (packet.body.hasOwnProperty('cancel')) {
            let [m, type, application, id] = ID_REGEX.exec(packet.body.cancel);

            switch (type) {
                case 'fdo':
                    this.device.service.remove_notification(parseInt(id));
                    break;

                case 'gtk':
                    this.device.service.remove_notification(id, application);
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
     * @param {String} ticker - The notification's expected content
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
     * @param {String} ticker - The notification's expected content
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
    _uploadIcon(packet, icon) {
        return new Promise((resolve, reject) => {
            switch (true) {
                case (this.device.connection_type === 'bluetooth'):
                    this.device.sendPacket(packet);
                    break;
                case (typeof icon === 'string'):
                    this._uploadNamedIcon(packet, icon);
                    break;
                case (icon instanceof Gio.BytesIcon):
                    this._uploadBytesIcon(packet, icon.get_bytes());
                    break;
                case (icon instanceof Gio.FileIcon):
                    this._uploadFileIcon(packet, icon.get_file());
                    break;
                case (icon instanceof Gio.ThemedIcon):
                    if (icon.hasOwnProperty('name')) {
                        this._uploadNamedIcon(packet, icon.name);
                    } else {
                        this._uploadNamedIcon(packet, icon.names[0]);
                    }
                    break;
                default:
                    this.device.sendPacket(packet);
            }

            resolve();
        }).catch(logError);
    }

    /**
     * A function for uploading named icons from a GLib.Bytes object.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {GLib.Bytes} bytes - The themed icon name
     */
    _uploadBytesIcon(packet, bytes) {
        this._uploadIconStream(
            packet,
            Gio.MemoryInputStream.new_from_bytes(bytes),
            bytes.get_size(),
            GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                bytes.toArray()
            )
        );
    }

    /**
     * A function for uploading named icons. kdeconnect-android can't handle SVG
     * icons, so if another is not found the notification will be sent without.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {String} icon_name - The themed icon name
     */
    _uploadNamedIcon(packet, icon_name) {
        let theme = Gtk.IconTheme.get_default();
        let info = theme.lookup_icon(
            icon_name,
            Math.max.apply(null, theme.get_icon_sizes(icon_name)),
            Gtk.IconLookupFlags.NO_SVG
        );

        if (info) {
            this._uploadFileIcon(
                packet,
                Gio.File.new_for_path(info.get_filename())
            );
        } else {
            this.device.sendPacket(packet);
        }
    }

    /**
     * A function for uploading icons as Gio.File objects
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.File} file - A Gio.File object for the icon
     */
    _uploadFileIcon(packet, file) {
        this._uploadIconStream(
            packet,
            file.read(null),
            file.query_info('standard::size', 0, null).get_size(),
            GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                file.load_contents(null)[1]
            )
        );
    }

    /**
     * All icon types end up being uploaded in this function.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.InputStream} stream - A stream to read the icon bytes from
     * @param {Number} size - Size of the icon in bytes
     * @param {String} checksum - MD5 hash of the icon data
     */
    _uploadIconStream(packet, stream, size, checksum) {
        let transfer = new Lan.Transfer({
            device: this.device,
            size: size,
            input_stream: stream
        });

        transfer.connect('connected', (channel) => transfer.start());

        transfer.upload().then(port => {
            packet.payloadSize = size;
            packet.payloadTransferInfo = { port: port };
            packet.body.payloadHash = checksum;

            this.device.sendPacket(packet);
        });
    }

    /**
     * This is called by the daemon; See Daemon._sendNotification()
     */
    async sendNotification(notif) {
        debug(`(${notif.appName}) ${notif.title}: ${notif.text}`);

        let applications = JSON.parse(this.settings.get_string('applications'));

        // New application
        if (!applications.hasOwnProperty(notif.appName)) {
            debug(`new application: ${notif.appName}`);

            applications[notif.appName] = {
                iconName: (typeof notif.icon === 'string') ? notif.icon : 'system-run-symbolic',
                enabled: true
            };

            this.settings.set_string(
                'applications',
                JSON.stringify(applications)
            );
        }

        if (applications[notif.appName].enabled) {
            let icon = null;

            // Named/Themed Icon
            if (typeof notif.icon === 'string') {
                icon = notif.icon;
                delete notif.icon;

            // Probably a GIcon
            } else if (typeof notif.icon === 'object') {
                debug(notif.icon);

                if (notif.icon[0] === 'themed') {
                    icon = Gio.Icon.deserialize(
                        new GLib.Variant('(sv)', [
                            notif.icon[0],
                            new GLib.Variant('as', notif.icon[1])
                        ])
                    );
                }

                delete notif.icon;
            }

            let packet = {
                id: 0,
                type: 'kdeconnect.notification',
                body: notif
            };

            return await this._uploadIcon(packet, icon);
        }
    }

    /**
     * Receiving Notifications
     */
    _downloadIcon(packet) {
        debug([packet.payloadTransferInfo.port, packet.payloadSize, packet.body.payloadHash]);

        return new Promise((resolve, reject) => {
            if (packet.payloadTransferInfo.hasOwnProperty('port')) {
                let iconStream = Gio.MemoryOutputStream.new_resizable();

                let transfer = new Lan.Transfer({
                    device: this.device,
                    size: packet.payloadSize,
                    checksum: packet.body.payloadHash,
                    output_stream: iconStream
                });

                transfer.connect('connected', (transfer) => transfer.start());
                transfer.connect('failed', (transfer) => resolve(null));
                transfer.connect('succeeded', (transfer) => {
                    iconStream.close(null);
                    resolve(Gio.BytesIcon.new(iconStream.steal_as_bytes()));
                });

                transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
            } else if (packet.payloadTransferInfo.hasOwnProperty('uuid')) {
                resolve(null);
            }
        });
    }

    /**
     * This mimics _parsePacket() from the telephony plugin, then calls either
     * telephony.Plugin.callNotification() or telephony.Plugin.smsNotification()
     */
    _showTelephonyNotification(notif, contact, icon, type) {
        let telephony = this.device.lookup_plugin('telephony');

        let event = {
            id: notif.id,
            type: type,
            contact: contact,
            number: contact.numbers[0].number,
            time: parseInt(notif.time)
        };

        // Update contact avatar
        if (!contact.avatar && icon instanceof Gio.BytesIcon) {
            debug('updating avatar for ' + event.contact.name);
            contact.avatar = GLib.build_filenamev([
                Contacts.CACHE_DIR,
                GLib.uuid_string_random() + '.jpeg'
            ]);
            GLib.file_set_contents(
                contact.avatar,
                icon.get_bytes().toArray().toString()
            );
            this.contacts._writeCache();
        }

        if (event.type === 'sms') {
            event.content = notif.text;
            return telephony.smsNotification(event);
        } else if (event.type === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            event.content = _('Missed call at %s').format(event.time);
            return telephony.callNotification(event);
        }
    }

    receiveNotification(packet, icon) {
        return new Promise((resolve, reject) => {
            //
            let notif = {
                id: packet.body.id,
                icon: icon
            };

            // Check if this is a missed call or SMS notification
            let isMissedCall = packet.body.id.includes('MissedCall');
            let isSms = packet.body.id.includes('sms');

            if (isSms || isMissedCall) {
                // Track the notification so the telephony action can close it later
                let duplicate;

                if ((duplicate = this._duplicates.get(packet.body.ticker))) {
                    duplicate.id = packet.body.id;
                } else {
                    this._duplicates.set(packet.body.ticker, { id: packet.body.id });
                }
            }

            // If it's an event we support, look for a known contact, but don't
            // create a new one since we'll only have name *or* number with no
            // decent way to tell which
            let contact;
            let telephony = this.device.lookup_plugin('telephony');

            if (isSms && telephony) {
                debug('An SMS notification');
                contact = this.contacts.query({
                    name: packet.body.title,
                    number: packet.body.title,
                    single: true
                });
            } else if (isMissedCall && telephony) {
                debug('A missed call notification');
                contact = this.contacts.query({
                    name: packet.body.text,
                    number: packet.body.text,
                    single: true
                });
            }

            // This is a missed call or SMS from a known contact
            if (contact) {
                debug('Found known contact');

                return this._showTelephonyNotification(
                    packet.body,
                    contact,
                    icon,
                    (isMissedCall) ? 'missedCall' : 'sms'
                );
            // A regular notification or notification from an unknown contact
            } else {
                // Ignore 'appName' if it's the same as 'title' or this is SMS
                if (packet.body.appName === packet.body.title || isSms) {
                    notif.title = packet.body.title;
                    notif.body = packet.body.text;
                // Otherwise use the appName as the title
                } else {
                    notif.title = packet.body.appName;
                    notif.body = packet.body.ticker;
                }
            }

            // If we don't have an avatar or payload icon, fallback on
            // notification type, appName then device type
            if (!notif.icon) {
                if (isMissedCall) {
                    notif.icon = new Gio.ThemedIcon({ name: 'call-missed-symbolic' });
                } else if (isSms) {
                    notif.icon = new Gio.ThemedIcon({ name: 'sms-symbolic' });
                } else {
                    notif.icon = new Gio.ThemedIcon({
                        names: [
                            packet.body.appName.toLowerCase().replace(' ', '-'),
                            this.device.type + '-symbolic'
                        ]
                    });
                }
            }

            let duplicate;

            if ((duplicate = this._duplicates.get(packet.body.ticker))) {
                // We've been asked to close this
                if (duplicate.close) {
                    this.closeNotification(packet.body.id);
                    this._duplicates.delete(packet.body.ticker);
                // We've been asked to silence this (we'll still track it)
                } else if (duplicate.silence) {
                    duplicate.id = packet.body.id;
                // This is a missed call/SMS notification
                } else {
                    this.device.showNotification(notif);
                }
            // We can show this as normal
            } else {
                this.device.showNotification(notif);
            }

            return;
        }).catch(e => logError(e, this.device.name));
    }

    /**
     * Report that a local notification has been closed/dismissed
     * @param {String} id - The local notification id
     */
    cancelNotification(id) {
    }

    /**
     * Close a remote notification
     * @param {String} id - The remote notification id
     */
    closeNotification(id) {
        debug(id)

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.request',
            body: { cancel: id }
        });
    }

    /**
     * Reply to a notification sent with a requestReplyId UUID
     * TODO: this is untested and not used yet
     */
    replyNotification(id, text) {
        debug(arguments);

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.reply',
            body: {
                replyId: id,
                messageBody: text
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

