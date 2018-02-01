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
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Notifications"),
    description: _("Sync notifications between devices"),
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
 *
 * TODO: GNotification seems to set a limit of 3 notifications in a short period
 *       consider allowing clients to handle notifications/use signals
 *       make local notifications closeable (serial/reply_serial)
 *       The current beta supports:
 *           requestReplyId {string} - a UUID for replying (?)
 *           title {string} - The remote's title of the notification
 *           text {string} - The remote's body of the notification
 */
var Plugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginsBase.Plugin,
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

        this._duplicates = new Map();

        if (this.settings.get_boolean("receive-notifications")) {
            this.request();
        }
    },

    _getIconInfo: function (iconName) {
        let theme = Gtk.IconTheme.get_default();
        let sizes = theme.get_icon_sizes(iconName);

        return theme.lookup_icon(
            iconName,
            Math.max.apply(null, sizes),
            Gtk.IconLookupFlags.NO_SVG
        );
    },

    _createNotification: function (packet, icon) {
        let notif = new Gio.Notification();

        // Check if this is a missed call or SMS notification
        let isMissedCall = (packet.body.title === _("Missed call"));
        let isSms = (packet.body.id.indexOf("sms") > -1);

        // Check if it's from a known contact
        let contact, plugin;

        if (isMissedCall || isSms) {
            if ((plugin = this.device._plugins.get("telephony"))) {
                contact = plugin._cache.searchContact(
                    (isSms) ? packet.body.title : packet.body.text
                );
            }
        }

        if (contact) {
            if (!contact.avatar && icon) {
                // FIXME: not saving cache?
                let path = plugin._cache._dir + "/" + GLib.uuid_string_random() + ".jpeg";
                GLib.file_set_contents(path, icon.get_bytes());
                contact.avatar = path;
            } else if (contact.avatar && !icon) {
                icon = plugin._getPixbuf(contact.avatar);
            }

            // Format as a missed call notification
            if (isMissedCall) {
                notif.set_title(_("Missed Call"));
                notif.set_body(
                    _("Missed call from %s on %s").format(
                        contact.name || contact.number,
                        this.device.name
                    )
                );
                notif.add_button(
                    // TRANSLATORS: Reply to a missed call by SMS
                    _("Message"),
                    "app.replyMissedCall(('" +
                    this._dbus.get_object_path() +
                    "','" +
                    escape(contact.number) +
                    "','" +
                    escape(contact.name) +
                    "'))"
                );
            // Format as an SMS notification
            } else if (isSms) {
                notif.set_title(contact.name || contact.number);
                notif.set_body(packet.body.text);
                notif.set_default_action(
                    "app.replySms(('" +
                    this._dbus.get_object_path() +
                    "','" +
                    escape(contact.number) +
                    "','" +
                    escape(contact.name) +
                    "','" +
                    escape(packet.body.text) +
                    "'))"
                );
                notif.set_priority(Gio.NotificationPriority.HIGH);
            }

            // Track the notification so the action can close it later
            let duplicate;

            if ((duplicate = this._duplicates.get(packet.body.ticker))) {
                duplicate.id = packet.body.id;
            } else {
                this._duplicates.set(packet.body.ticker, { id: packet.body.id });
            }
        } else {
            // Try to correct duplicate appName/title situations
            if (packet.body.appName === packet.body.title || isSms) {
                notif.set_title(packet.body.title);
                notif.set_body(packet.body.text);
            } else {
                notif.set_title(packet.body.appName);
                notif.set_body(packet.body.ticker);
            }

            notif.set_default_action(
                "app.closeNotification(('" +
                this._dbus.get_object_path() +
                "','" +
                escape(packet.body.id) +
                "'))"
            );
            notif.set_priority(Gio.NotificationPriority.NORMAL);
        }

        // Fallback if we still don't have an icon
        if (!icon) {
            let name = packet.body.appName.toLowerCase().replace(" ", "-");

            if (isMissedCall) {
                icon = new Gio.ThemedIcon({ name: "call-missed-symbolic" });
            } else if (isSms) {
                icon = new Gio.ThemedIcon({ name: "sms-symbolic" });
            } else if (Gtk.IconTheme.get_default().has_icon(name)) {
                icon = new Gio.ThemedIcon({ name: name });
            } else {
                icon = new Gio.ThemedIcon({
                    name: this.device.type + "-symbolic"
                });
            }
        }

        notif.set_icon(icon);

        this._postNotification(packet, notif, packet.body.ticker);
    },

    _postNotification: function (packet, notif) {
        debug("Notification: _postNotification('" + packet.body.ticker + "')");

        let duplicate;

        if ((duplicate = this._duplicates.get(packet.body.ticker))) {
            // We've been asked to close this
            if (duplicate.close) {
                this.close(packet.body.id);
                this._duplicates.delete(packet.body.ticker);
            // We've been asked to silence this (we'll still track it)
            } else if (duplicate.silence) {
                duplicate.id = packet.body.id;
            // This is a missed call/SMS notification
            } else {
                this.device.daemon.send_notification(
                    this.device.id + "|" + packet.body.id,
                    notif
                );
            }
        // We can show this as normal
        } else {
            this.device.daemon.send_notification(
                this.device.id + "|" + packet.body.id,
                notif
            );
        }
    },

    // Icon transfers
    _downloadIcon: function (packet) {
        debug("Notification: _downloadIcon()");

        let iconStream = Gio.MemoryOutputStream.new_resizable();

        let channel = new Protocol.LanDownloadChannel(
            this.device.daemon,
            this.device.id,
            iconStream
        );

        channel.connect("connected", (channel) => {
            let transfer = new Protocol.Transfer(
                channel,
                packet.payloadSize,
                packet.body.payloadHash
            );

            transfer.connect("failed", (transfer) => {
                channel.close();
                this._createNotification(packet);
            });

            transfer.connect("succeeded", (transfer) => {
                channel.close();
                iconStream.close(null);
                this._createNotification(
                    packet,
                    Gio.BytesIcon.new(iconStream.steal_as_bytes())
                );
            });

            transfer.start();
        });

        let addr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string(
                this.device.settings.get_string("tcp-host")
            ),
            port: packet.payloadTransferInfo.port
        });

        channel.open(addr);
    },

    _uploadIcon: function (packet, iconInfo) {
        debug("Notification: _uploadIcon()");

        let file = Gio.File.new_for_path(iconInfo.get_filename());
        let info = file.query_info("standard::size", 0, null);

        let channel = new Protocol.LanUploadChannel(
            this.device.daemon,
            this.device.id,
            file.read(null)
        );

        channel.connect("listening", (channel, port) => {
            packet.payloadSize = info.get_size();
            packet.payloadTransferInfo = { port: port };
            packet.body.payloadHash = GLib.compute_checksum_for_bytes(
                GLib.ChecksumType.MD5,
                file.load_contents(null)[1]
            );

            this.device._channel.send(packet);
        });

        channel.connect("connected", (channel) => {
            let transfer = new Protocol.Transfer(
                channel,
                info.get_size()
            );

            transfer.connect("failed", () => channel.close());
            transfer.connect("succeeded", () => channel.close());

            transfer.start();
        });

        channel.open();
    },

    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        debug("Notification: Notify()");

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

                let iconInfo = this._getIconInfo(iconName);

                if (iconInfo) {
                    this._uploadIcon(packet, iconInfo);
                } else {
                    this.device._channel.send(packet);
                }
            }
        }
    },

    _fixNotification: function (packet) {
        // kdeconnect-android 1.6.6 (hex: 20 e2 80 90 20)
        if (packet.body.ticker.indexOf(" ‐ ") > -1) {
            debug("Notification: fixing legacy notification");
            [packet.body.title, packet.body.text] = packet.body.ticker.split(" ‐ ");
            packet.body.ticker = packet.body.ticker.replace(" ‐ ", ": ");
        }

        return packet;
    },

    handlePacket: function (packet) {
        debug("Notification: handlePacket()");

        if (packet.type === "kdeconnect.notification.request") {
            // TODO: KDE Connect says this is unused...
        } else if (this.settings.get_boolean("receive-notifications")) {
            if (packet.body.isCancel) {
                this.device.withdraw_notification(packet.body.id);
            // Ignore GroupSummary notifications
            } else if (packet.body.id.indexOf("GroupSummary") > -1) {
                debug("Notification: ignoring GroupSummary notification");
            // Ignore grouped SMS notifications
            } else if (packet.body.id.indexOf(":sms|") > -1) {
                debug("Notification: ignoring grouped SMS notification");
            } else if (packet.payloadSize) {
                packet = this._fixNotification(packet);
                this._downloadIcon(packet);
            } else {
                packet = this._fixNotification(packet);
                this._createNotification(packet);
            }
        }
    },

    /**
     * Mark a notification to be closed if received (not shown locally and
     * closed remotely)
     * @param {string} matchString - The notification's expected content
     */
    closeDuplicate: function (matchString) {
        debug("Notification: closeDuplicate('" + matchString + "')");

        if (this._duplicates.has(matchString)) {
            let duplicate = this._duplicates.get(matchString);

            if (duplicate.id) {
                this.close(duplicate.id);
                this._duplicates.delete(matchString);
            } else {
                duplicate.close = true;
            }
        } else {
            this._duplicates.set(matchString, { close: true });
        }
    },

    /**
     * Mark a notification to be silenced if received (not shown locally)
     * @param {string} matchString - The notification's expected content
     */
    silenceDuplicate: function (matchString) {
        debug("Notification: silenceDuplicate('" + matchString + "')");

        if (this._duplicates.has(matchString)) {
            this._duplicates.get(matchString).silence = true;
        } else {
            this._duplicates.set(matchString, { silence: true });
        }
    },

    /**
     * Close a remote notification
     * @param {string} id - The notification id
     */
    close: function (id) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { cancel: id }
        });

        this.device._channel.send(packet);
    },

    /**
     * Reply to a notification sent with a requestReplyId UUID
     * TODO: kdeconnect-android 1.7+ only, this is untested and not used yet
     */
    reply: function (id, appName, title, text) {
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

                this.device._channel.send(packet);
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

        this.device._channel.send(packet);
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


var SettingsDialog = new Lang.Class({
    Name: "GSConnectNotificationSettingsDialog",
    Extends: PluginsBase.SettingsDialog,

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let generalSection = this.content.addSection(
            null,
            null,
            { width_request: -1 }
        );

        generalSection.addGSetting(this.settings, "receive-notifications");
        generalSection.addGSetting(this.settings, "send-notifications");

        this.appSection = this.content.addSection(
            _("Applications"),
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        this.settings.bind(
            "send-notifications",
            this.appSection,
            "sensitive",
            Gio.SettingsBindFlags.DEFAULT
        );

        this._applications = JSON.parse(this.settings.get_string("applications"));
        this._populate();

        this.appSection.list.set_sort_func((row1, row2) => {
            return row1.appName.label.localeCompare(row2.appName.label);
        });

        this.content.show_all();
    },

    _populate: function () {
        this._query();

        for (let name in this._applications) {
            let row = this.appSection.addRow();

            try {
                row.appIcon = new Gtk.Image({
                    icon_name: this._applications[name].iconName,
                    pixel_size: 32
                });
            } catch (e) {
                row.appIcon = new Gtk.Image({
                    icon_name: "application-x-executable",
                    pixel_size: 32
                });
            }
            row.grid.attach(row.appIcon, 0, 0, 1, 1);

            row.appName = new Gtk.Label({
                label: name,
                hexpand: true,
                xalign: 0
            });
            row.grid.attach(row.appName, 1, 0, 1, 1);

            row.appSwitch = new Gtk.Switch({
                active: this._applications[name].enabled,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER
            });
            row.appSwitch.connect("notify::active", (widget) => {
                this._applications[row.appName.label].enabled = row.appSwitch.active;
                this.settings.set_string(
                    "applications",
                    JSON.stringify(this._applications)
                );
            });
            row.grid.attach(row.appSwitch, 2, 0, 1, 1);
        }
    },

    _query: function () {
        // Query Gnome's notification settings
        let desktopSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.notifications"
        });

        for (let app of desktopSettings.get_strv("application-children")) {
            let appSettings = new Gio.Settings({
                schema_id: "org.gnome.desktop.notifications.application",
                path: "/org/gnome/desktop/notifications/application/" + app + "/"
            });

            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string("application-id")
            );

            if (appInfo) {
                let name = appInfo.get_name();

                if (!this._applications[name]) {
                    this._applications[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        // Include applications that statically declare to show notifications
        for (let appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_boolean("X-GNOME-UsesNotifications")) {
                let name = appInfo.get_name();

                if (!this._applications[name]) {
                    this._applications[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        this.settings.set_string(
            "applications",
            JSON.stringify(this._applications)
        );
    }
});

