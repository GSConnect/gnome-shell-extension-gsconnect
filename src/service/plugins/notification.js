'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
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
            outgoing: ['kdeconnect.notification.request'],
            allow: 6
        },
        receiveNotification: {
            summary: _('Receive Notification'),
            description: _('Display a remote notification locally'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: ['kdeconnect.notification'],
            outgoing: [],
            allow: 4
        },
        sendNotification: {
            summary: _('Send Notification'),
            description: _('Display a local notification remotely'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: [],
            outgoing: ['kdeconnect.notification'],
            allow: 2
        }
    },
    events: {}
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
    GTypeName: 'GSConnectNotificationsPlugin',
    Properties: {
        'notifications': GObject.param_spec_variant(
            'notifications',
            'NotificationList',
            'A list of active or expected notifications',
            new GLib.VariantType('aa{sv}'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
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
            if (this.allow & 4) {
                // TODO: A request for our notifications; NotImplemented
                return;
            }
        } else if (this.allow & 2) {
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
        debug(icon);

        if (typeof icon === 'string') {
            this._uploadNamedIcon(packet, icon);
        } else if (icon instanceof Gio.BytesIcon) {
            this._uploadBytesIcon(packet, icon.get_bytes());
        } else if (icon instanceof Gio.FileIcon) {
            this._uploadFileIcon(packet, icon.get_file());
        } else if (icon instanceof Gio.ThemedIcon) {
            this._uploadNamedIcon(packet, icon.name);
        }
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
    sendNotification(notif) {
        debug(`(${notif.appName}) ${notif.title}: ${notif.text}`);

        return new Promise((resolve, reject) => {
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

            if ((this.allow & 2) && applications[notif.appName].enabled) {
                let icon = notif.icon;
                delete notif.icon;

                let packet = {
                    id: 0,
                    type: 'kdeconnect.notification',
                    body: notif
                };

                if (icon) {
                    this._uploadIcon(packet, icon);
                } else {
                    this.device.sendPacket(packet);
                }

                resolve(`'${notif.appName}' notification forwarded`);
            } else {
                resolve(true);
            }
        }).catch(debug);
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
                id: packet.id,
                icon: icon
            };

            // Check if this is a missed call or SMS notification
            let isMissedCall = (packet.body.id.indexOf('MissedCall') > -1);
            let isSms = (packet.body.id.indexOf('sms') > -1);

            // If it's an event we support, look for a known contact, but don't
            // create a new one since we'll only have name *or* number with no
            // decent way to tell which
            let action, contact;

            if (isSms && this.device.get_action_enabled('smsNotification')) {
                debug('An SMS notification');
                contact = this.contacts.query({
                    name: packet.body.title,
                    number: packet.body.title,
                    single: true
                });
                action = this.device.lookup_action('smsNotification');
            } else if (isMissedCall && this.device.get_action_enabled('callNotification')) {
                debug('A missed call notification');
                contact = this.contacts.query({
                    name: packet.body.text,
                    number: packet.body.text,
                    single: true
                });
                action = this.device.lookup_action('callNotification');
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

                action.activate(gsconnect.full_pack(event));
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
        }).catch(debug);
    }

    /**
     * Start tracking a notification as active or expected
     * @param {Object} notif - The body or facsimile from a notification packet
     */
    trackNotification(notif) {
        this._notifications.push(notif);
        this.notify('notifications');
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
            this.notify('notifications');
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
     * TODO: could probably use telepathy...
     */
    reply(id, appName, title, text) {
        debug(arguments);

        let dialog = new ReplyDialog(this.device, appName, title, text);
        dialog.connect('delete-event', dialog.destroy);
        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                this.device.sendPacket({
                    id: 0,
                    type: 'kdeconnect.notification.reply',
                    body: {
                        replyId: id,
                        messageBody: dialog.entry.buffer.text
                    }
                });
            }

            dialog.destroy();
        });

        dialog.show_all();
    }

    /**
     * Request the remote notifications be sent
     */
    request() {
        if (!(this.allow & 4)) {
            return;
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.notification.request',
            body: { request: true }
        });
    }
});


var ReplyDialog = GObject.registerClass({
    GTypeName: 'GSConnectNotificationReplyDialog',
}, class ReplyDialog extends Gtk.Dialog {

    _init(device, appName, title, text) {
        super._init({
            use_header_bar: true,
            application: Gio.Application.get_default(),
            default_height: 300,
            default_width: 300
        });

        let headerBar = this.get_header_bar();
        headerBar.title = appName;
        headerBar.subtitle = device.name;
        headerBar.show_close_button = false;

        let sendButton = this.add_button(_('Send'), Gtk.ResponseType.OK);
        sendButton.sensitive = false;
        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        let content = this.get_content_area();
        content.border_width = 6;
        content.spacing = 12

        let messageFrame = new Gtk.Frame({
            label_widget: new Gtk.Label({
                label: '<b>' + title + '</b>',
                use_markup: true
            }),
            label_xalign: 0.02
        });
        content.add(messageFrame);

        let textLabel = new Gtk.Label({
            label: text,
            margin: 6,
            xalign: 0
        });
        messageFrame.add(textLabel);

        let frame = new Gtk.Frame();
        content.add(frame);

        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        frame.add(scrolledWindow);

        this.entry = new Gtk.TextView({
            border_width: 6,
            halign: Gtk.Align.FILL,
            hexpand: true,
            valign: Gtk.Align.FILL,
            vexpand: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR
        });
        scrolledWindow.add(this.entry);

        this.entry.buffer.connect('changed', (buffer) => {
            sendButton.sensitive = (buffer.text.trim());
        });
    }
});

