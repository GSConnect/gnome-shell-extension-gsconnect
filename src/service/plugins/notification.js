"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Contacts = imports.modules.contacts;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Notification",
    incomingCapabilities: ["kdeconnect.notification", "kdeconnect.notification.request"],
    outgoingCapabilities: ["kdeconnect.notification", "kdeconnect.notification.reply", "kdeconnect.notification.request"],
    actions: {
        showNotification: {
            summary: _("Show Notification"),
            description: _("Display a remote notification locally"),
            signature: "av",
            incoming: ["kdeconnect.notification"],
            outgoing: [],
            allow: 4
        },
        closeNotification: {
            summary: _("Close Notification"),
            description: _("Close a remote notification by Id"),
            signature: "s",
            incoming: [],
            outgoing: ["kdeconnect.notification.request"],
            allow: 6
        },
        sendNotification: {
            summary: _("Send Notification"),
            description: _("Display a local notification remotely"),
            signature: "av",
            incoming: [],
            outgoing: ["kdeconnect.notification"],
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
 *      type: "kdeconnect.notification",
 *      body: {
 *          payloadHash: {String} MD5 Hash of payload data
 *                                (eg. "85ac3d1f77feb592f38dff6ae4f843e1"),
 *          requestReplyId: {String} UUID for repliable notifications aka
 *                                   Quick Reply (eg. "91bce2ab-873f-4056-8e91-16fd2f5781ec"),
 *          id: {String} The remote notification's Id
 *                       (eg. "0|com.google.android.apps.messaging|0|com.google.android.apps.messaging:sms:22|10109"),
 *          appName: {String} The application name (eg. "Messages"),
 *          isClearable: {Boolean} Whether the notification can be closed,
 *          ticker: {String} Usually <title> and <text> joined with ": ". For
 *                           SMS it's "<contactName|phoneNumber>: <messageBody>",
 *          title: {String} Notification title, or <contactName|phoneNumber> for SMS,
 *          text: {String} Notification body, or <messageBody> for SMS,
 *          time: {String} String of epoch microseconds the notification
 *                         was *posted* (eg. "1517817308985"); this resets when
 *                         an Android device resets.
 *      },
 *      "payloadSize": {Number} Payload size in bytes,
 *      "payloadTransferInfo": {
 *          "port": {Number} Port number between 1739-1764 for transfer
 *      }
 *  }
 *
 *
 * TODO: consider allowing clients to handle notifications/use signals
 *       make local notifications closeable (serial/reply_serial)
 *       requestReplyId {string} - a UUID for replying (?)
 */
var Plugin = GObject.registerClass({
    GTypeName: "GSConnectNotificationsPlugin",
    Properties: {
        "notifications": GObject.param_spec_variant(
            "notifications",
            "NotificationList",
            "A list of active or expected notifications",
            new GLib.VariantType("aa{sv}"),
            new GLib.Variant("aa{sv}", []),
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, "notification");

        this.contacts = Contacts.getStore();

        this._notifications = [];
        this.cacheProperties(["_notifications"]);

        // TODO
//        if (this.allow & 4) {
//            this.request();
//        }
    }

    get notifications () {
        return this._notifications;
    }

    handlePacket(packet) {
        debug(packet);

        if (packet.type === "kdeconnect.notification.request") {
            if (this.allow & 4) {
                // TODO: A request for our notifications; NotImplemented
                return;
            }
        } else if (this.allow & 2) {
            if (packet.body.isCancel) {
                this.device.withdraw_notification(packet.body.id);
                this.untrackNotification(packet.body);
                debug("closed notification");
            // Ignore previously posted notifications
            } else if (this._getNotification(packet.body)) {
                debug("ignored cached notification");
            } else if (packet.payloadSize) {
                debug("new notification with payload");
                this._downloadIcon(packet).then(icon => {
                    return this.showNotification(packet, icon);
                }).catch(e => {
                    debug(e);
                    this.showNotification(packet);
                });
            } else {
                debug("new notification");
                this.showNotification(packet);
            }
        }
    }

    /**
     * Search the cache for a notification by data and return it or %false if
     * not found
     */
    _getNotification(query) {
        for (let notif of this._notifications) {
            // @query is a full notification matching a timestamp (shown)
            // We check for timestamp first since the device controls id
            // turnover and timestamps only change if the phone resets.
            if (notif.time && notif.time === query.time) {
                debug("found notification with matching timestamp");
                Object.assign(notif, query);
                return notif;
            // TODO: confirm this works...
            // @query is a full notification matching an id (shown)
            // We also have to check for id, since some applications update
            // notifications (desktop-style) by reusing the id...
            } else if (notif.id && notif.id === query.id) {
                debug("found notification with matching id");
                Object.assign(notif, query);

                // If we made it this far it's the same id, but different
                // timestamp & ticker ("title: text") so the device probably
                // considers it an 'update'
                return (notif.ticker === query.ticker) ? notif : false;
            } else if (notif.localId) {
                // @query is a duplicate stub matching a GNotification id
                // closeNotification(id|localId) or markDuplicate(localId)
                if ([query.id, query.localId].indexOf(notif.localId) > -1) {
                    debug("found duplicate with matching localId");
                    return notif;
                // @query is a full notification matching an expected duplicate
                // handlePacket(id)
                } else if (query.time && notif.ticker === query.ticker) {
                    debug("found duplicate with matching ticker");

                    // Update the duplicate stub
                    Object.assign(notif, query);

                    // It's marked to be closed
                    if (notif.isCancel) {
                        debug("closing duplicate notification");
                        this.closeNotification(notif.id);
                    }

                    return notif;
                }
            }
        }

        return false;
    }

    /**
     * Sending Notifications
     */
    _uploadIcon(packet, icon) {
        debug(icon);

        if (typeof icon === "string") {
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
            gfile.query_info("standard::size", 0, null).get_size(),
            GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                gfile.load_contents(null)[1]
            )
        );
    }

    _uploadIconStream(packet, stream, size, checksum) {
        let transfer = new Protocol.Transfer({
            device: this.device,
            size: size,
            input_stream: stream
        });

        transfer.connect("connected", (channel) => transfer.start());

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
            let applications = JSON.parse(this.settings.get_string("applications"));

            // New application
            if (!applications.hasOwnProperty(notif.appName)) {
                debug(`new application: ${notif.appName}`);

                applications[notif.appName] = {
                    iconName: (typeof notif.icon === "string") ? notif.icon : "system-run-symbolic",
                    enabled: true
                };

                this.settings.set_string(
                    "applications",
                    JSON.stringify(applications)
                );
            }

            if ((this.allow & 2) && applications[notif.appName].enabled) {
                let icon = notif.icon;
                delete notif.icon;

                let packet = {
                    id: 0,
                    type: "kdeconnect.notification",
                    body: notif
                };

                if (icon) {
                    this._uploadIcon();
                } else {
                    this.device.sendPacket(packet);
                }

                resolve(`'${notif.appName}' notification forwarded`);
            } else {
                resolve(true);
            }
        }).catch(e => debug(e));
    }

    /**
     * Receiving Notifications
     */
    _downloadIcon(packet) {
        debug([packet.payloadTransferInfo.port, packet.payloadSize, packet.body.payloadHash]);

        return new Promise((resolve, reject) => {
            let iconStream = Gio.MemoryOutputStream.new_resizable();

            let transfer = new Protocol.Transfer({
                device: this.device,
                size: packet.payloadSize,
                checksum: packet.body.payloadHash,
                output_stream: iconStream
            });

            transfer.connect("connected", (transfer) => transfer.start());
            transfer.connect("failed", (transfer) => resolve(null));
            transfer.connect("succeeded", (transfer) => {
                //iconStream.close(null);
                resolve(Gio.BytesIcon.new(iconStream.steal_as_bytes()));
            });

            transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
        });
    }

            );

            this.device.sendPacket(packet);
        });
    }

    showNotification(packet, icon) {
        return new Promise((resolve, reject) => {
            let notif = {};

            // Check if this is a missed call or SMS notification
            // TODO: maybe detect by app id
            let isMissedCall = (packet.body.title === _("Missed call"));
            let isSms = (packet.body.id.indexOf("sms") > -1);

            // If it's an event we support, look for a known contact, but don't
            // create a new one since we'll only have name *or* number with no
            // decent way to tell which
            let contact;

            if (isSms && this.device.lookup_action("replySms")) {
                debug("An SMS notification");
                contact = this.contacts.query({
                    name: packet.body.title,
                    number: packet.body.title,
                    single: true
                });
            } else if (isMissedCall && this.device.lookup_action("replySms")) {
                debug("A missed call notification");
                contact = this.contacts.query({
                    name: packet.body.text,
                    number: packet.body.text,
                    single: true
                });
            }

            // This is a missed call or SMS from a known contact
            if (contact) {
                debug("Found known contact");

                if (!contact.avatar && icon) {
                    contact.avatar = GLib.build_filenamev([
                        Contacts.CACHE_DIR,
                        GLib.uuid_string_random() + ".jpeg"
                    ]);
                    // FIXME: not saving proper (data)?
                    log("ICON BYTES: " + icon.get_bytes());
                    GLib.file_set_contents(
                        contact.avatar,
                        icon.get_bytes().toArray().toString()
                    );
                } else if (contact.avatar && !icon) {
                    icon = Contacts.getPixbuf(contact.avatar);
                }

                // Format as a missed call notification
                if (isMissedCall) {
                    notif.title = _("Missed Call");
                    notif.body = _("Missed call from %s on %s").format(
                        contact.name || contact.numbers[0].number,
                        this.device.name
                    );
                    notif.buttons = [{
                        action: "replySms",
                        // TRANSLATORS: Reply to a missed call by SMS
                        label: _("Message"),
                        params: {
                            type: "missedCall",
                            contact: contact,
                            number: contact.numbers[0].number,
                            time: packet.body.time,
                            content: packet.body.text
                        }
                    }];
                    notif.priority = Gio.NotificationPriority.NORMAL;
                // Format as an SMS notification
                } else if (isSms) {
                    notif.title = contact.name || contact.numbers[0].number;
                    notif.body = packet.body.text;
                    notif.action = {
                        name: "replySms",
                        params: {
                            type: "sms",
                            contact: contact,
                            number: contact.numbers[0].number,
                            time: packet.body.time,
                            content: packet.body.text
                        }
                    };
                    notif.priority = Gio.NotificationPriority.HIGH;
                }
            // A regular notification or notification from an unknown contact
            } else {
                // Ignore 'appName' if it's the same as 'title' or this is SMS
                if (packet.body.appName === packet.body.title || isSms) {
                    notif.set_title(packet.body.title);
                    notif.set_body(packet.body.text);
                // Otherwise use the appName as the title
                } else {
                    notif.set_title(packet.body.appName);
                    notif.set_body(packet.body.ticker);
                }
            }

            // If we don't have an avatar or payload icon, fallback on
            // notification type, appName then device type
            if (!icon) {
                if (isMissedCall) {
                    icon = new Gio.ThemedIcon({ name: "call-missed-symbolic" });
                } else if (isSms) {
                    icon = new Gio.ThemedIcon({ name: "sms-symbolic" });
                } else {
                    icon = new Gio.ThemedIcon({
                        names: [
                            packet.body.appName.toLowerCase().replace(" ", "-"),
                            this.device.type + "-symbolic"
                        ]
                    });
                }
            }

            this.trackNotification(packet.body);
            this.device.showNotification(notif);

            resolve(true);
        }).catch(e => debug(e));
    }

    /**
     * Start tracking a notification as active or expected
     */
    trackNotification(notif) {
        this._notifications.push(notif);
        this.notify("notifications");
    }

    untrackNotification(notif) {
        let cachedNotif = this._getNotification(notif);

        if (cachedNotif) {
            let index_ = this._notifications.indexOf(cachedNotif);
            this._notifications.splice(index_, 1);
            this.notify("notifications");
        }
    }

    /**
     * Mark a notification as handled by Telephony.
     * @param {Object} notif - A notification stub
     * @param {String} notif.localId - The local GNotification Id
     * @param {String} notif.ticker - The expected 'ticker' field
     * @param {Boolean} [notif.isCancel] - Whether the notification should be closed
     */
    markDuplicate(notif) {
        debug(notif);

        // Check if this is a known duplicate
        let cachedNotif = this._getNotification(notif);

        // If we're asking to close it...
        if (cachedNotif && notif.isCancel) {
            // ...close it now if we know the remote id
            if (cachedNotif.id) {
                debug("closing notification '" + cachedNotif.id + "'");
                debug("closing duplicate notification");
                this.closeNotification(cachedNotif.id);
            // ...or mark it to be closed when we do
            } else {
                debug("marking duplicate notification to be closed");
                cachedNotif.isCancel = true;
            }
        // Start tracking it now
        } else {
            log("FIXME: shouldn't be reached");
            this.trackNotification(notif);
        }
    }

    /**
     * Close a remote notification and remove it from the cache
     * @param {string} timestamp - The remote notification timestamp
     */
    closeNotification(timestamp) {
        debug(timestamp);

        // Check if this is a known notification (by timestamp)
        let cachedNotif = this._getNotification({ time: timestamp });

        // If it is known and we have the remote id we can close it...
        if (cachedNotif && cachedNotif.hasOwnProperty("id")) {
            debug("closing notification '" + cachedNotif.id + "'");

            this.device.sendPacket({
                id: 0,
                type: "kdeconnect.notification.request",
                body: { cancel: cachedNotif.id }
            });
            this.untrackNotification(cachedNotif);
        // ...or we mark it to be closed on arrival if it is known
        } else if (cachedNotif) {
            debug("marking duplicate notification to be closed");
            cachedNotif.isCancel = true;
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
        dialog.connect("delete-event", dialog.destroy);
        dialog.connect("response", (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                let packet = new Protocol.Packet({
                    id: 0,
                    type: "kdeconnect.notification.reply",
                    body: {
                        replyId: id,
                        messageBody: dialog.entry.buffer.text
                    }
                });

                this.device.sendPacket(packet);
            }

            dialog.destroy();
        });

        dialog.show_all();
    }

    /**
     * Request the remote notifications be sent
     */
    request() {
        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { request: true }
        });
    }
});


var ReplyDialog = GObject.registerClass({
    GTypeName: "GSConnectNotificationReplyDialog",
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

        let sendButton = this.add_button(_("Send"), Gtk.ResponseType.OK);
        sendButton.sensitive = false;
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        let content = this.get_content_area();
        content.border_width = 6;
        content.spacing = 12

        let messageFrame = new Gtk.Frame({
            label_widget: new Gtk.Label({
                label: "<b>" + title + "</b>",
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

        this.entry.buffer.connect("changed", (buffer) => {
            sendButton.sensitive = (buffer.text.trim());
        });
    }
});

