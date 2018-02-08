"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Contacts = imports.modules.contacts;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Notification",
    incomingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.request"
    ],
    outgoingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.reply",
        "kdeconnect.notification.request"
    ]
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
 *       The current beta supports:
 *           requestReplyId {string} - a UUID for replying (?)
 *           title {string} - The remote's title of the notification
 *           text {string} - The remote's body of the notification
 */
var Plugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginsBase.Plugin,
    Properties: {
        "notifications": GObject.param_spec_variant(
            "notifications",
            "NotificationList",
            "A list of active or expected notifications",
            new GLib.VariantType("aa{sv}"),
            new GLib.Variant("aa{sv}", []),
            GObject.ParamFlags.READABLE
        ),
        "Notifications": GObject.param_spec_variant(
            "Notifications",
            "NotificationList",
            "A list of active or expected notifications",
            new GLib.VariantType("aa{sv}"),
            new GLib.Variant("aa{sv}", []),
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        },
        "dismissed": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function (device) {
        this.parent(device, "notification");

        this.contacts = Contacts.getStore();

        this._notifications = [];
        this.cacheProperties(["_notifications"]);

        if (this.allow & 4) {
            this.request();
        }

        // Request missed notifications after donotdisturb ends
        gsconnect.settings.connect("changed::donotdisturb", () => {
            let now = GLib.DateTime.new_now_local().to_unix();
            if (gsconnect.settings.get_int("donotdisturb") < now) {
                if (this.allow & 4) {
                    this.request();
                }
            }
        });
    },

    //
    get notifications () {
        return this._notifications;
    },

    get Notifications () {
        return this._notifications.map((notif) => Object.toVariant(notif));
    },

    handlePacket: function (packet) {
        debug(packet);

        return new Promise((resolve, reject) => {
            if (packet.type === "kdeconnect.notification.request") {
                if (this.allow & 4) {
                }
                // TODO: A request for our notifications; NotImplemented
            } else if (this.allow & 2) {
                // Ignore GroupSummary notifications
                if (packet.body.id.indexOf("GroupSummary") > -1) {
                    debug("ignoring GroupSummary notification");
                    resolve(false);
                // Ignore grouped SMS notifications
                } else if (packet.body.id.indexOf(":sms|") > -1) {
                    debug("ignoring grouped SMS notification");
                    resolve(false);
                } else if (packet.body.isCancel) {
                    this.device.withdraw_notification(packet.body.id);
                    this.untrackNotification(packet.body);
                    resolve(false);
                // Ignore previously posted notifications
                } else if (this._getNotification(packet.body)) {
                    debug("ignoring cached notification");
                    resolve(false);
                } else if (packet.payloadSize) {
                    debug("new notification with payload");
                    this._downloadIcon(packet).then((result) => {
                        resolve(this._createNotification(packet, result));
                    });
                } else {
                    debug("new notification");
                    resolve(this._createNotification(packet));
                }
            }
        });
    },

    /**
     * DBus Interface
     */
    Close: function (id) {
        this.close(id);
    },

    /**
     * Private Methods
     */

    /** Get the path to the largest PNG of @name */
    _getIconPath: function (name) {
        let theme = Gtk.IconTheme.get_default();
        let sizes = theme.get_icon_sizes(name);
        let info = theme.lookup_icon(
            name,
            Math.max.apply(null, sizes),
            Gtk.IconLookupFlags.NO_SVG
        );

        return (info) ? info.get_filename() : false;
    },

    /**
     * Search for a notification by data and return it or false if not found
     */
    _getNotification: function (query) {
        for (let notif of this._notifications) {
            // @query matches an active/shown notification timestamp
            if (notif.time && notif.time === query.time) {
                debug("found notification by timestamp");
                // Update the cached notification
                Object.assign(notif, query);
                return notif;
            } else if (notif.localId) {
                // @query is a duplicate search by GNotification id
                // Called by close() or markDuplicate()
                if ([query.id, query.localId].indexOf(notif.localId) > -1) {
                    debug("found notification by localId");
                    return notif;
                // @query is a notification matching a duplicate we're expecting
                // Called by handlePacket()
                } else if (query.time && notif.ticker === query.ticker) {
                    debug("found duplicate with matching ticker");

                    // Update the duplicate stub
                    Object.assign(notif, query);

                    // It's marked to be closed
                    if (notif.isCancel) {
                        debug("closing duplicate notification");
                        this.close(notif.id);
                    }

                    return notif;
                }
            }
        }

        return false;
    },

    _createNotification: function (packet, icon) {
        return new Promise((resolve, reject) => {
            let notif = new Gio.Notification();

            // Check if this is a missed call or SMS notification
            // TODO: maybe detect by app id
            let isMissedCall = (packet.body.title === _("Missed call"));
            let isSms = (packet.body.id.indexOf("sms") > -1);

            // If it's an event we support, look for a known contact, but don't
            // create a new one since we'll only have name *or* number
            let contact;

            if (isSms && this.device.lookup_action("replySms")) {
                debug("An SMS notification");
                contact = this.contacts.query({
                    name: packet.body.title,
                    number: packet.body.title,
                    single: true
                });
            } else if (isMissedCall && this.device.lookup_action("replyMissedCall")) {
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
                    // FIXME FIXME FIXME: not saving proper (data)?
                    let path = this.contacts._cacheDir + "/" + GLib.uuid_string_random() + ".jpeg";
                    log("BYTES: " + icon.get_bytes());
                    return;
                    GLib.file_set_contents(path, icon.get_bytes().toArray().toString());
                    contact.avatar = path;
                } else if (contact.avatar && !icon) {
                    icon = this.contacts.getContactPixbuf(contact.avatar);
                }

                // Format as a missed call notification
                if (isMissedCall) {
                    notif.set_title(_("Missed Call"));
                    notif.set_body(
                        _("Missed call from %s on %s").format(
                            contact.name || contact.numbers[0].number,
                            this.device.name
                        )
                    );
                    notif.add_button(
                        // TRANSLATORS: Reply to a missed call by SMS
                        _("Message"),
                        "replyMissedCall",
                        this._dbus.get_object_path(),
                        [contact.numbers[0].number,
                        contact.name,
                        packet.body.time]
                    );
                    notif.set_priority(Gio.NotificationPriority.NORMAL);
                // Format as an SMS notification
                } else if (isSms) {
                    notif.set_title(contact.name || contact.numbers[0].number);
                    notif.set_body(packet.body.text);
                    notif.set_device_action(
                        this._dbus.get_object_path(),
                        "replySms",
                        [contact.numbers[0].number,
                        contact.name,
                        packet.body.text,
                        packet.body.time]
                    );
                    notif.set_priority(Gio.NotificationPriority.HIGH);
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

            notif.set_icon(icon);

            // TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO
            // Cache the notification only if it will actually be shown
            let now = GLib.DateTime.new_now_local().to_unix();
            if (gsconnect.settings.get_int("donotdisturb") < now) {
                this.trackNotification(packet.body);
                this.device.send_notification(packet.body.id, notif);
                log("SHOWING NOTIFICATION");
            }

            // FIXME
            resolve(true);
        });
    },

    // Icon transfers
    _downloadIcon: function (packet) {
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
            transfer.connect("failed", (transfer) => {
                channel.close();
                resolve(null);
            });
            transfer.connect("succeeded", (transfer) => {
                channel.close();
                resolve(Gio.BytesIcon.new(iconStream.steal_as_bytes()));
            });

            transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
        });
    },

    _uploadIcon: function (packet, filename) {
        debug("Notification: _uploadIcon()");

        let file = Gio.File.new_for_path(filename);
        let info = file.query_info("standard::size", 0, null);

        let transfer = new Protocol.Transfer({
            device: this.device,
            size: info.get_size(),
            input_stream: file.read(null)
        });

        transfer.connect("connected", (channel) => transfer.start());
        transfer.connect("failed", () => channel.close());
        transfer.connect("succeeded", () => channel.close());

        transfer.upload().then(port => {
            packet.payloadSize = info.get_size();
            packet.payloadTransferInfo = { port: port };
            packet.body.payloadHash = GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                file.load_contents(null)[1]
            );

            this.send(packet); // FIXME method name
        });
    },

    /**
     * This is called by the daemon
     */
    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        debug("Notification: Notify()");

        if (!appName) {
            return;
        }

        let applications = JSON.parse(this.settings.get_string("applications"));

        // New application
        if (appName && !applications.hasOwnProperty(appName)) {
            applications[appName] = { iconName: iconName, enabled: true };
            this.settings.set_string(
                "applications",
                JSON.stringify(applications)
            );
        }

        if (this.settings.get_boolean("send-notifications")) {
            if (applications[appName].enabled) {
                let packet = new Protocol.Packet({
                    id: 0,
                    type: "kdeconnect.notification",
                    body: {
                        appName: appName,
                        id: replacesId.toString(),
                        isClearable: (replacesId),
                        ticker: body
                    }
                });

                let iconPath = this._getIconPath(iconName);

                if (iconPath) {
                    this._uploadIcon(packet, iconPath);
                } else {
                    this.send(packet);
                }
            }
        }
    },

    /**
     * Start tracking a notification as active or expected
     */
    trackNotification: function (notif) {
        this._notifications.push(notif);
        this.notify("notifications");
        this.notify("Notifications", "aa{sv}");
    },

    untrackNotification: function (notif) {
        let cnotif = this._getNotification(notif);

        if (cnotif) {
            let index_ = this._notifications.indexOf(cnotif);
            this._notifications.splice(index_, 1);
            this.notify("notifications");
            this.notify("Notifications", "aa{sv}");
        }
    },

    /**
     * Mark a notification as handled by Telephony.
     * @param {Object} notif - A notification stub
     * @param {String} notif.localId - The local GNotification Id
     * @param {String} notif.ticker - The expected 'ticker' field
     * @param {Boolean} [notif.isCancel] - Whether the notification should be closed
     */
    markDuplicate: function (notif) {
        debug(arguments);

        // Check if this is a known duplicate
        let cachedNotif = this._getNotification(notif);

        // If we're asking to close it...
        if (cachedNotif && notif.isCancel) {
            // ...close it now if we know the remote id
            if (cachedNotif.id) {
                debug("closing duplicate notification");
                this.close(cachedNotif.id);
            // ...or mark it to be closed when we do
            } else {
                debug("marking duplicate notification to be closed");
                cachedNotif.isCancel = true;
            }
        // Start tracking it now
        } else {
            this.trackNotification(notif);
        }
    },

    /**
     * Close a remote notification and remove it from the cache
     * @param {string} id - The either the local id or remote timestamp
     */
    close: function (id) {
        debug(id);

        // Check if this is a known notification
        let cnotif = this._getNotification({ id: id });

        if (cnotif && cnotif.hasOwnProperty("id")) {
            // If it doesn't have a remoteId use the local Id
            let remoteId = cnotif.hasOwnProperty("id") ? cnotif.id : id;

            let packet = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.notification.request",
                body: { cancel: remoteId }
            });

            debug("closing notification with id '" + id + "'");

            this.send(packet);
            this.untrackNotification(cnotif);
        }
    },

    /**
     * Reply to a notification sent with a requestReplyId UUID
     * TODO: this is untested and not used yet
     */
    reply: function (id, appName, title, text) {
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

                this.send(packet);
            }

            dialog.destroy();
        });

        dialog.show_all();
    },

    /**
     * Request the remote notifications be sent
     */
    request: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { request: true }
        });

        this.send(packet);
    }
});


var ReplyDialog = Lang.Class({
    Extends: Gtk.Dialog,
    Name: "GSConnectNotificationReplyDialog",

    _init: function (device, appName, title, text) {
        this.parent({
            use_header_bar: true,
            application: device.daemon,
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

