"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "notifications",
    summary: _("Notifications"),
    description: _("Sync notifications between devices"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Notifications-Plugin",
    incomingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.request"
    ],
    outgoingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.reply",
        "kdeconnect.notification.request"
    ],
    settings: {
        receive: {
            enabled: true
        },
        send: {
            enabled: true,
            icons: true,
            applications: {
                GSConnect: {
                    iconName: "phone",
                    enabled: false
                }
            }
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
 * There are several possible variables for an incoming notification:
 *
 *    body.id {string} - This is supposedly and "internal" Android Id, such as:
 *                      "0|org.kde.kdeconnect_tp|-256692160|null|10114"
 *    body.isCancel {boolean} - If true, the notification "id" was closed by the peer
 *    body.isClearable {boolean} - If true, we can reply with "cancel: <id>"
 *    body.appName {string} - The notifying application, just like libnotify
 *    body.ticker {string} - Like libnotify's "body", unless there's a summary
 *        (such as with an SMS where the summary would be the sender's name)
 *        the value would be "summary: body"
 *    body.silent {boolean} - This either means "don't show" or "low urgency"
 *    body.requestAnswer {boolean} - This is an answer to a "request"
 *       kdeconnect-android also uses this for clients not supporting "silent"
 *    body.request {boolean} - If true, we're being asked to send a list of notifs
 * For icon syncing:
 *    body.payloadHash {string} - An MD5 hash of the payload data
 *    payloadSize {number} - the notification icon size in bytes
 *    payloadTransferInfo {object} - Just like regular (with a property 'port')
 *
 * The current beta seems to also send:
 *
 *    requestReplyId {string} - a UUID for replying (?)
 *    title {string} - The remote's title of the notification
 *    text {string} - The remote's body of the notification
 *
 * TODO: support payloadHash for uploaded icons
 *       convert themed SVG->PNG for icon uploads?
 *       requestAnswer usage?
 *       urgency filter (outgoing)?
 *       make "shared" notifications clearable (Can KDE Connect even do this?)
 *       consider option for notifications allowing clients to handle them
 *       use signals
 */
var Plugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "dismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "notifications");
        
        this._duplicates = new Map();
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
    
    _handleDuplicate: function (packet, notif) {
        let matchString
        
        // kdeconnect-android 1.7+ only
        if (packet.body.hasOwnProperty("title")) {
            matchString = packet.body.title + ": " + packet.body.text;
        } else {
            matchString = packet.body.ticker;
        }
        
        if (this._duplicates.has(matchString)) {
            let duplicate = this._duplicates.get(matchString);
            
            // We've been asked to close this
            if (duplicate.mark_read) {
                this.close(packet.body.id);
                this._duplicates.delete(matchString);
            // We've been asked to silence this (we'll still track it)
            } else if (duplicate.silence) {
                duplicate.id = packet.body.id;
            }
        // We can show this as normal
        } else {
            this.device.daemon.send_notification(packet.body.id, notif);
        }
    },
    
    _handleNotification: function (packet) {
        Common.debug("Notifications: _handleNotification()");
        
        if (packet.body.isCancel) {
            this.device.daemon.withdraw_notification(packet.body.id);
        // Ignore GroupSummary notifications
        } else if (packet.body.id.indexOf("GroupSummary") > -1) {
            Common.debug("Notifications: ignoring GroupSummary notification");
            return;
        } else {
            let notif = new Gio.Notification();
            notif.set_title(packet.body.appName);
            notif.set_body(packet.body.ticker);
            notif.set_default_action(
                "app.closeNotification(('" +
                this._dbus.get_object_path() +
                "','" +
                escape(packet.body.id) +
                "'))"
            );
            
            if (packet.payloadSize) {
                let iconStream = Gio.MemoryOutputStream.new_resizable();
                
                let channel = new Protocol.LanDownloadChannel(
                    this.device.daemon,
                    this.device.identity,
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
                        notif.set_icon(
                            new Gio.ThemedIcon({ name: "phone-symbolic" })
                        );
                        this._handleDuplicate(packet, notif);
                    });
                    
                    transfer.connect("succeeded", (transfer) => {
                        channel.close();
                        iconStream.close(null);
                        notif.set_icon(
                            Gio.BytesIcon.new(iconStream.steal_as_bytes())
                        );
                        this._handleDuplicate(packet, notif);
                    });
                    
                    transfer.start();
                });
            
                let addr = new Gio.InetSocketAddress({
                    address: Gio.InetAddress.new_from_string(
                        this.device.identity.body.tcpHost
                    ),
                    port: packet.payloadTransferInfo.port
                });
                
                channel.open(addr);
            // If this is an SMS use an SMS icon
            } else if (packet.body.id.indexOf("sms") > -1) {
                notif.set_icon(new Gio.ThemedIcon({ name: "sms-symbolic" }));
                this._handleDuplicate(packet, notif);
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "phone-symbolic" }));
                this._handleDuplicate(packet, notif);
            }
            
            // FIXME
            if (packet.body.requestAnswer) {
                Common.debug("Notifications: this is an answer to a request");
            }
        }
    },
    
    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        // Signature: str,     uint,       str,      str,     str,  array,   obj,   uint
        Common.debug("Notifications: Notify()");
        
        Common.debug("appName: " + appName);
        Common.debug("replacesId: " + replacesId);
        Common.debug("iconName: " + iconName);
        Common.debug("summary: " + summary);
        Common.debug("body: " + body);
        Common.debug("actions: " + actions);
        Common.debug("hints: " + JSON.stringify(hints));
        Common.debug("timeout: " + timeout);
        
        // New application
        if (!this.settings.send.applications.hasOwnProperty(appName)) {
            this.settings.send.applications[appName] = {
                iconName: iconName,
                enabled: true
            };
            
            Common.writeDeviceConfiguration(this.device.id, this.device.config);
        }
        
        if (this.settings.send.enabled) {
            if (this.settings.send.applications[appName].enabled) {
                let packet = new Protocol.Packet({
                    id: Date.now(),
                    type: "kdeconnect.notification",
                    body: {
                        appName: appName,
                        id: replacesId.toString(),  // TODO: clearable if !0?
                        isClearable: false,
                        ticker: body
                    }
                });
                
                let iconInfo;
                
                if (this.settings.send.icons) {
                    iconInfo = this._getIconInfo(iconName);
                }
                
                if (iconInfo) {
                    Common.debug("Icon Filename: " + iconInfo.get_filename());
                    
                    let file = Gio.File.new_for_path(iconInfo.get_filename());
                    let info = file.query_info("standard::size", 0, null);
                    
                    let channel = new Protocol.LanUploadChannel(
                        this.device.daemon,
                        this.device.identity,
                        file.read(null)
                    );
            
                    channel.connect("listening", (channel, port) => {
                        packet.payloadSize = info.get_size();
                        packet.payloadTransferInfo = { port: port };
                        
                        this.device._channel.send(packet);
                    });
                    
                    channel.connect("connected", (channel) => {
                        let transfer = new Protocol.Transfer(
                            channel,
                            info.get_size()
                        );
                        
                        transfer.connect("failed", (transfer) => {
                            channel.close();
                        });
                    
                        transfer.connect("succeeded", (transfer) => {
                            channel.close();
                        });
                
                        transfer.start();
                    });
            
                    channel.open();
                } else {
                    this.device._channel.send(packet);
                }
            }
        }
    },
    
    handlePacket: function (packet) {
        Common.debug("Notifications: handlePacket()");
        
        if (packet.type === "kdeconnect.notification" && this.settings.receive.enabled) {
            this._handleNotification(packet);
        } else if (packet.type === "kdeconnect.notification.request") {
            // TODO: KDE Connect says this is unused...
        }
    },
    
    closeDuplicate: function (matchString) {
        if (this._duplicates.has(matchString)) {
            let duplicate = this._duplicates.get(matchString);
                
            if (duplicate.id) {
                this.close(duplicate.id);
            } else {
                duplicate.mark_read = true;
            }
        } else {
            this._duplicates.set(matchString, { mark_read: true });
        }
    },
    
    silenceDuplicate: function (matchString) {
        if (this._duplicates.has(matchString)) {
            this._duplicates.get(matchString).silence = true;
        } else {
            this._duplicates.set(matchString, { silence: true });
        }
    },
    
    close: function (id) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { cancel: id }
        });
        
        this.device._channel.send(packet);
    },
    
    // TODO: ???
    reply: function () {
    },
    
    // TODO: request notifications
    update: function () {
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectNotificationsSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        // Receiving
        let generalSection = this.content.addSection(
            null,
            null,
            { width_request: -1 }
        );
        
        let receiveSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.receive.enabled
        });
        receiveSwitch.connect("notify::active", (widget) => {
            this.settings.receive.enabled = receiveSwitch.active;
        });
        generalSection.addSetting(
            _("Receive Notifications"),
            null,
            receiveSwitch
        );
        
        // Sending
        let sendSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.send.enabled
        });
        sendSwitch.connect("notify::active", (widget) => {
            this.settings.send.enabled = sendSwitch.active;
        });
        generalSection.addSetting(
            _("Send Notifications"),
            null,
            sendSwitch
        );
        
        let iconsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.send.icons
        });
        iconsSwitch.connect("notify::active", (widget) => {
            this.settings.send.icons = iconsSwitch.active;
        });
        let iconsRow = generalSection.addSetting(
            _("Send Icons With Notifications"),
            null,
            iconsSwitch
        );
        sendSwitch.bind_property(
            "active",
            iconsRow,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        
        this.appSection = this.content.addSection(
            _("Applications"),
            null,
            {
                margin_bottom: 0,
                selection_mode: Gtk.SelectionMode.SINGLE,
                width_request: -1
            }
        );
        
        this._populate();
        
        let removeRow = this.appSection.addRow(null, { activatable: true });
        removeRow.grid.margin = 0;
        removeRow.grid.hexpand = true;
        removeRow.grid.halign = Gtk.Align.CENTER;
        removeRow.image = Gtk.Image.new_from_icon_name(
            "list-remove-symbolic",
            Gtk.IconSize.BUTTON
        );
        removeRow.grid.attach(removeRow.image, 0, 0, 1, 1);
        
        this.appSection.list.set_sort_func((row1, row2) => {
            if (row2.image) { return -1; }
            return row1.appName.label.localeCompare(row2.appName.label);
        });
        
        this.appSection.list.connect("row-activated", (listbox, row) => {
            this.appSection.list.selected_foreach((listbox, row) => {
                this._remove(row);
            });
        });
        
        this.content.show_all();
    },
    
    _populate: function () {
        this._query();
    
        for (let name in this.settings.send.applications) {
            let row = this.appSection.addRow(
                null,
                { selectable: true }
            );
            
            try {
                row.icon = Gtk.Image.new_from_icon_name(
                    this.settings.send.applications[name].iconName,
                    Gtk.IconSize.DND
                );
            } catch (e) {
                row.icon = Gtk.Image.new_from_icon_name(
                    "application-x-executable",
                    Gtk.IconSize.DND
                );
            }
            row.grid.attach(row.icon, 0, 0, 1, 1);
            
            row.appName = new Gtk.Label({
                label: name,
                hexpand: true,
                xalign: 0
            });
            row.grid.attach(row.appName, 1, 0, 1, 1);
            
            row.switch = new Gtk.Switch({
                active: this.settings.send.applications[name].enabled
            });
            row.switch.connect("notify::active", (widget) => {
                this.settings.send.applications[name].enabled = row.switch.active;
            });
            row.grid.attach(row.switch, 2, 0, 1, 1);
        }
    },
    
    _query: function () {
        // Query Gnome's notification settings
        let settings = new Gio.Settings({
            schema_id: "org.gnome.desktop.notifications"
        });
        
        for (let app of settings.get_strv("application-children")) {
            let appSettings = Gio.Settings.new_with_path(
                "org.gnome.desktop.notifications.application",
                "/org/gnome/desktop/notifications/application/" + app + "/"
            );
            
            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string("application-id")
            );
            
            if (appInfo) {
                let name = appInfo.get_name();
                
                if (!this.settings.send.applications.hasOwnProperty(name)) {
                    this.settings.send.applications[name] = {
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
                
                if (!this.settings.send.applications.hasOwnProperty(name)) {
                    this.settings.send.applications[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }
    },
    
    _remove: function (row) {
        if (this.settings.send.applications.hasOwnProperty(row.appName.label)) {
            delete this.settings.send.applications[row.appName.label];
        }
        this.appSection.list.remove(row);
    }
});


