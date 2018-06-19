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
 *      type: 'kdeconnect.notification',
 *      body: {
 *          id: {string} The remote notification's Id,
 *          appName: {string} The application name,
 *          isClearable: {boolean} Whether the notification can be closed,
 *          title: {string} Notification title, or <contactName|phoneNumber> for SMS,
 *          text: {string} Notification body, or <messageBody> for SMS,
 *          ticker: {string} Usually <title> and <text> joined with ': ',
 *          time: {string} local timestamp (ms) the notification was posted,
 *          requestReplyId: {string} UUID for repliable notifications,
 *          payloadHash: {string} MD5 Hash of payload data (optional)
 *      },
 *      'payloadSize': {number} Payload size in bytes,
 *      'payloadTransferInfo': {
 *          'port': {number} Port number between 1739-1764 for transfer (TCP),
 *          'uuid': {string} Service UUID for transfer (Bluetooth)
 *      }
 *  }
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectNotificationPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'notification');

        this.contacts = Contacts.getStore();

        // Duplicate tracking of telephony notifications
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
        // kdeconnect.notification packet with isCancel and an id of "0". Other
        // clients might only support uint32 ids anyways since kdeconnect-kde
        // only explicitly supports libnotify.
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
    _uploadIcon(packet, icon) {
        return new Promise((resolve, reject) => {
            switch (true) {
                // TODO: skipping icons for bluetooth connections currently
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
     * @param {string} icon_name - The themed icon name
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
     * @param {number} size - Size of the icon in bytes
     * @param {string} checksum - MD5 hash of the icon data
     */
    _uploadIconStream(packet, stream, size, checksum) {
        if (this.device.connection_type === 'tcp') {
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

        // TODO: skipping icons for bluetooth connections currently
        } else if (this.device.connection_type === 'bluetooth') {
            this.device.sendPacket(packet);
        }
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
        return new Promise((resolve, reject) => {
            if (!packet.hasOwnProperty('payloadTransferInfo')) {
                resolve(null);
            }

            let iconStream = Gio.MemoryOutputStream.new_resizable();

            if (packet.payloadTransferInfo.hasOwnProperty('port')) {
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

                transfer.download(packet.payloadTransferInfo.port).catch(debug);
            } else if (packet.payloadTransferInfo.hasOwnProperty('uuid')) {
                resolve(null);
            }
        });
    }

    /**
     * This mimics _parseEvent() from the telephony plugin, updates the contact
     * avatar (if necessary), then calls either callNotification() or
     * smsNotification() from the telephony plugin.
     *
     * @param {object} notif - The body of a kdeconnect.notification packet
     * @param {object} contact - A contact object
     * @param {Gio.Icon|null} icon - The notification icon (nullable)
     * @param {string} type - The event type; either "missedCall" or "sms"
     */
    _showTelephonyNotification(notif, contact, icon, type) {
        let telephony = this.device.lookup_plugin('telephony');

        // Fabricate a message packet from what we know
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
        if (!contact.avatar && (icon instanceof Gio.BytesIcon)) {
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

        if (message.event === 'sms') {
            message.body = notif.text;
            return telephony.smsNotification(contact, message);
        } else if (message.event === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith
            message.body = _('Missed call from %s').format(contact.name);
            return telephony.callNotification(contact, message);
        }
    }

    /**
     * Receive an incoming notification, either handling it as a duplicate of a
     * telephony notification or displaying to the user.
     *
     * @param {kdeconnect.notification} packet - The notification packet
     */
    async receiveNotification(packet) {
        //
        let icon = await this._downloadIcon(packet);

        // Check if this is a missed call or SMS notification
        let isMissedCall = packet.body.id.includes('MissedCall');
        let isSms = packet.body.id.includes('sms');
        let telephony = this.device.get_plugin_enabled('telephony');
        let isTelephony = (telephony && (isMissedCall || isSms));

        // Check if it's a duplicate early so we can skip unnecessary work
        let duplicate = this._duplicates.get(packet.body.ticker);

        // This has been marked as a duplicate by the telephony plugin
        if (isTelephony && duplicate) {
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

        // If it's an event we support
        if (isTelephony) {
            // Track the notification so a telephony action can close it
            this._duplicates.set(packet.body.ticker, { id: packet.body.id });

            // Look for a contact with a single phone number, but don't create
            // one since we only get a number or a name
            let contact = this.contacts.query({
                name: (isSms) ? packet.body.title : packet.body.text,
                number: (isSms) ? packet.body.title : packet.body.text,
                single: true
            });

            // If found, send this as a telephony notification
            if (contact) {
                return this._showTelephonyNotification(
                    packet.body,
                    contact,
                    icon,
                    (isMissedCall) ? 'missedCall' : 'sms'
                );
            }
        }

        // A regular notification or notification from an unknown contact
        let notif = {
            id: packet.body.id,
            icon: icon
        };

        // Ignore 'appName' if it's the same as 'title' or this is SMS
        if (packet.body.appName === packet.body.title || isSms) {
            notif.title = packet.body.title;
            notif.body = packet.body.text;
        // Otherwise use the appName as the title
        } else {
            notif.title = packet.body.appName;
            notif.body = packet.body.ticker;
        }

        // If we don't have an avatar or payload icon, fallback on notification
        // type, appName then device type
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

        this.device.showNotification(notif);
    }

    /**
     * Report that a local notification has been closed/dismissed.
     * TODO: kdeconnect-android doesn't handle incoming isCancel packets.
     *
     * @param {string} id - The local notification id
     */
    cancelNotification(id) {
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
     *
     * @param {string} id - The remote notification id
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

