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

        this._notifications = [];
        this.cacheProperties(['_notifications']);

        // Request remote notifications (if permitted)
        this.request();
    }

    get notifications () {
        return this._notifications;
    }

    handlePacket(packet) {
        debug(packet);

        if (packet.type === 'kdeconnect.notification.request') {
            return;
        } else if (packet.type === 'kdeconnect.notification') {
            if (packet.body.isCancel) {
                // TODO: call org.gtk.Notifications->RemoveNotification()
                this.device.withdraw_notification(packet.body.id);
                this.untrackNotification(packet.body);
                debug('closed notification');
            // Ignore previously posted notifications
            } else if (this._matchNotification(packet.body)) {
                debug('ignored cached notification');
            } else if (packet.payloadSize) {
                debug('new notification with payload');
                this._downloadIcon(packet).then(icon => {
                    return this.receiveNotification(packet, icon);
                }).catch(e => {
                    debug(e);
                    this.receiveNotification(packet);
                });
            } else {
                debug('new notification');
                this.receiveNotification(packet);
            }
        }
    }

    /**
     * Search the cache for a notification by data and return it or %false if
     * not found
     */
    _matchNotification(query) {
        for (let i = 0; i < this._notifications.length; i++) {
            let notif = this._notifications[i];

            // Check for telephony duplicates first
            if (notif.telId) {
                // @query is a duplicate stub matching a GNotification id
                // closeNotification(telId) or markDuplicate(telId)
                if (query.telId && query.telId === notif.telId) {
                    debug(`duplicate/matching telId: ${query.telId}`);
                    return Object.assign(notif, query);
                // @query is a duplicate notification matching a known ticker
                // handlePacket(id)
                } else if ((notif.id || query.id) && query.ticker === notif.ticker) {
                    debug(`duplicate/matching ticker: ${query.ticker}`);

                    // Update the duplicate stub
                    Object.assign(notif, query);

                    // It's marked to be closed
                    if (notif.isCancel) {
                        debug(`duplicate/isCancel: ${notif.id}`);
                        //this.closeNotification(notif.id);

                        this.device.sendPacket({
                            id: 0,
                            type: 'kdeconnect.notification.request',
                            body: { cancel: notif.id }
                        });
                        this.untrackNotification(notif);
                    }

                    return notif;
                }
            // @query is a full notification matching a timestamp (shown)
            // We check for timestamp first since the device controls id
            // turnover and timestamps only change if the phone resets.
            } else if (notif.time && notif.time === query.time) {
                debug(`notification/matching timestamp`);
                return Object.assign(notif, query);
            // @query is a full notification matching an id
            } else if (notif.id && notif.id === query.id) {
                debug(`notification/matching id: ${notif.id}`);

                // Same id, but different ticker means it's likely an updated
                // notification, so update the cache and return %false to update
                if (notif.ticker !== query.ticker) {
                    debug(`notification/matching id/updated ticker: ${notif.ticker}`);
                    Object.assign(notif, query);
                    return false;
                }

                // Otherwise it's likely a duplicate with an updated timestamp
                debug(`notification/matching id/matching ticker: ${notif.ticker}`);
                return Object.assign(notif, query);
            // @query has a matching ticker
            } else if (notif.ticker === query.ticker) {
                debug(`notification/matching ticker: ${notif.ticker}`);
                return Object.assign(notif, query);
            }
        }

        // Start tracking the new notification and return %false
        this.trackNotification(query);
        return false;
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

    _uploadBytesIcon(packet, gbytes) {
        this._uploadIconStream(
            packet,
            Gio.MemoryInputStream.new_from_bytes(gbytes),
            gbytes.get_size(),
            GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                gbytes.toArray()
            )
        );
    }

    _uploadNamedIcon(packet, name) {
        let theme = Gtk.IconTheme.get_default();
        let sizes = theme.get_icon_sizes(name);
        let info = theme.lookup_icon(
            name,
            Math.max.apply(null, sizes),
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

    _uploadFileIcon(packet, gfile) {
        //debug(gfile);

        this._uploadIconStream(
            packet,
            gfile.read(null),
            gfile.query_info('standard::size', 0, null).get_size(),
            GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                gfile.load_contents(null)[1]
            )
        );
    }

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

            }

            let packet = {
                id: 0,
                type: 'kdeconnect.notification',
                body: notif
            };
            await this._uploadIcon(packet, icon);
            debug(`'${notif.appName}' notification forwarded`);
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
     *
     */
    _parseTelephonyNotification(notif, contact, icon, type) {
        let event = {
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
        } else if (event.type === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            event.content = _('Missed call at %s').format(event.time);
        }

        return event;
    }

    receiveNotification(packet, icon) {
        return new Promise((resolve, reject) => {
            //
            let notif = {
                id: packet.body.id,
                icon: icon
            };

            // Check if this is a missed call or SMS notification
            let isMissedCall = (packet.body.id.indexOf('MissedCall') > -1);
            let isSms = (packet.body.id.indexOf('sms') > -1);

            // If it's an event we support, look for a known contact, but don't
            // create a new one since we'll only have name *or* number with no
            // decent way to tell which
            let action, contact;
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

                let event = this._parseTelephonyNotification(
                    packet.body,
                    contact,
                    icon,
                    (isMissedCall) ? 'missedCall' : 'sms'
                );

                if (isMissedCall) {
                    telephony.callNotification(event);
                } else if (isSms) {
                    telephony.smsNotification(event);
                }

                return;
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

            this.device.showNotification(notif);
            return;
        }).catch(e => logError(e, this.device.name));
    }

    /**
     * Start tracking a notification as active or expected
     * @param {Object} notif - The body or facsimile from a notification packet
     */
    trackNotification(notif) {
        this._notifications.push(notif);
    }

    /**
     * Stop track a notification
     * @param {Object} notif - The body or facsimile from a notification packet
     */
    untrackNotification(notif) {
        let cachedNotif = this._matchNotification(notif);

        if (cachedNotif) {
            let index_ = this._notifications.indexOf(cachedNotif);
            this._notifications.splice(index_, 1);
        }
    }

    /**
     * Mark a notification as handled by Telephony.
     * @param {Object} notif - A notification stub
     * @param {String} notif.telId - The local GNotification Id
     * @param {String} notif.ticker - The expected 'ticker' field
     * @param {Boolean} [notif.isCancel] - Whether the notification should be closed
     */
    markDuplicate(stub) {
        debug(stub);

        let notif = this._matchNotification(stub);

        // If it's a known notification...
        if (notif) {
            // ...with a remote id, marked to be closed
            if (notif.id && notif.isCancel) {
                this.closeNotification(stub.telId);
            }
        }

        return notif;
    }

    /**
     * Close a remote notification and remove it from the cache
     * @param {string} query - The data used to find the notification
     */
    closeNotification(query) {
        debug(query);

        // Check if this is a known notification
        let notif;

        if (query.startsWith('sms') || query.startsWith('missedCall')) {
            notif = this._matchNotification({
                telId: query,
                ticker: query.split(/_(.+)/)[1]
            });
        } else {
            notif = this._matchNotification({ id: query });
        }

        // If it is known and we have the remote id we can close it...
        if (notif && notif.hasOwnProperty('id')) {
            debug(`${this.device.name}: closing notification ${notif.id}`);

            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.notification.request',
                body: { cancel: notif.id }
            });
            this.untrackNotification(notif);
        // ...or we mark it to be closed on arrival if it is known
        } else if (notif) {
            debug(`${this.device.name}: marking notification to be closed`);
            notif.isCancel = true;
        }
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
    request() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.request',
            body: { request: true }
        });
    }
});

