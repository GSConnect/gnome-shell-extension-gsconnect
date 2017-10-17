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
 *    id {string} - This is supposedly and "internal" Android Id, such as:
 *                      "0|org.kde.kdeconnect_tp|-256692160|null|10114"
 *    isCancel {boolean} - If true, the notification "id" was closed by the peer
 *    isClearable {boolean} - If true, we can reply with "isCancel"
 *    appName {string} - The notifying application, just like libnotify
 *    ticker {string} - The actual message, like libnotify's "body"
 *    silent {boolean} - KDE Connect seems to indicate this means "don't show"
 *    requestAnswer {boolean} - This is an answer to a "request"
 *    request {boolean} - If true, we're being asked to send a list of notifs
 *
 * TODO: play sounds when requested
 *       download/upload icons
 *       requestAnswer usage?
 *       urgency filter (outgoing)?
 *       make "shared" notifications clearable
 *       consider option for notifications allowing clients to handle them
 *       use signals
 */
var Plugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "notificationReceived": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "notificationDismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "notificationsDismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent(device, "notifications");
        
        this._freeze = false;
        this._notifications = new Map();
        this._sms = new Map();
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
                    id: 0,
                    type: "kdeconnect.notification",
                    body: {
                        silent: true,               // TODO
                        requestAnswer: false,       // for answering requests
                        id: replacesId.toString(),  // TODO
                        appName: appName,
                        isClearable: true,          // TODO
                        ticker: body,
                        time: Date.now()
                    }
                });
                
                this.device._channel.send(packet);
            }
        }
    },
    
    handlePacket: function (packet) {
        Common.debug("Notifications: handlePacket()");
        
        if (packet.type === "kdeconnect.notification" && this.settings.receive.enabled) {
            this._receiveNotification(packet);
        } else if (packet.type === "kdeconnect.notification.request") {
            // TODO: KDE Connect says this is unused??
        }
    },
    
    markReadSms: function (smsString) {
        if (this._sms.has(smsString)) {
            let duplicate = this._sms.get(smsString);
                
            if (duplicate.id) {
                this.close(duplicate.id);
            } else {
                duplicate.mark_read = true;
            }
        } else {
            this._sms.set(smsString, { mark_read: true });
        }
    },
    
    silenceSms: function (smsString) {
        if (this._sms.has(smsString)) {
            this._sms.get(smsString).silence = true;
        } else {
            this._sms.set(smsString, { silence: true });
        }
    },
    
    _receiveNotification: function (packet) {
        Common.debug("Notifications: _receiveNotification()");
        
        // TODO: check this over
        if (packet.body.isCancel) {
            if (this._notifications.has(packet.body.id)) {
                this.close(packet.body.id);
                this._notifications.delete(packet.body.id);
            }
        } else {
            let notif;
            
            // This is an update to a notification
            if (this._notifications.has(packet.body.id)) {
                notif = this._notifications.get(packet.body.id);
                notif.set_title(packet.body.appName);
                notif.set_body(packet.body.ticker);
                notif.set_icon(new Gio.ThemedIcon({ name: "phone-symbolic" }));
            // This is a new notification
            } else {
                notif = new Gio.Notification();
                notif.set_title(packet.body.appName);
                notif.set_body(packet.body.ticker);
                notif.set_icon(new Gio.ThemedIcon({ name: "phone-symbolic" }));
                notif.set_default_action(
                    "app.closeNotification(('" +
                    this._dbus.get_object_path() +
                    "','" +
                    packet.body.id +
                    "'))"
                );
                
                this._notifications.set(packet.body.id, notif);
            }
            
            if (packet.body.requestAnswer) {
                Common.debug("Notifications: this is an answer to a request");
            }
            
            // If this is an SMS we should check if it's a duplicate
            if (packet.body.id.indexOf("sms") > -1) {
                let smsString
                
                // KDE Connect Android 1.7+ only
                if (packet.body.hasOwnProperty("title")) {
                    smsString = packet.body.title + ": " + packet.body.text;
                } else {
                    smsString = packet.body.ticker;
                }
                
                if (this._sms.has(smsString)) {
                    let duplicate = this._sms.get(smsString);
                    
                    // We've been asked to mark this read (we'll close it)
                    if (duplicate.mark_read) {
                        this.close(packet.body.id);
                        this._sms.delete(smsString);
                    // We've been asked to silence this (we'll still track it)
                    } else if (duplicate.silence) {
                        duplicate.id = packet.body.id;
                    }
                // We can show this as normal
                } else {
                    this.device.daemon.send_notification(packet.body.id, notif);
                }
            // TODO: Apparently "silent" means don't show the notification, or
            //       maybe it just means "don't present" (aka low urgency)
            //} else if (!packet.body.silent) {
            } else {
                this.device.daemon.send_notification(packet.body.id, notif);
            }
        }
    },
    
    close: function (id) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { cancel: id }
        });
        
        this.device._channel.send(packet);
        
        if (this._notifications.has(id)) {
            this._notifications.delete(id);
        }
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
        let receivingSection = this.content.addSection(_("Receiving"));
        
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
        this.content.addItem(
            receivingSection,
            _("Receive Notifications"),
            // TRANSLATORS: eg. Enable to receive notifications from Google Pixel
            _("Enable to receive notifications from %s").format(this._page.device.name),
            receiveSwitch
        );
        
        // Sending
        let sendingSection = this.content.addSection(_("Sending"));
        
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
        this.content.addItem(
            sendingSection,
            _("Send Notifications"),
            // TRANSLATORS: eg. Enable to send notifications to Google Pixel
            _("Enable to send notifications to %s").format(this._page.device.name),
            sendSwitch
        );
        
        // Applications TreeView/Model
        let appRow = this.content.addRow(sendingSection);
        appRow.grid.row_spacing = 12;
        
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true,
            margin_top: 6,
            height_request: 100
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GdkPixbuf.Pixbuf,       // iconName
            GObject.TYPE_STRING,    // appName
            GObject.TYPE_BOOLEAN    // enabled
        ]);
        this.treeview.model = listStore;
        
        // Name column.
        this.appCell = new Gtk.CellRendererText({ editable: false });
        let appCol = new Gtk.TreeViewColumn({
            title: _("Application"),
            expand: true
        });
        
        // Icon
        let iconCell = new Gtk.CellRendererPixbuf();
        appCol.pack_start(iconCell, false);
        appCol.add_attribute(iconCell, "pixbuf", 0);
        appCol.pack_start(this.appCell, true);
        appCol.add_attribute(this.appCell, "text", 1);
        this.treeview.append_column(appCol);
        
        // Enabled column.
        this.sendCell = new Gtk.CellRendererToggle();
        let sendCol = new Gtk.TreeViewColumn({ title: _("Enabled") });
        sendCol.pack_start(this.sendCell, true);
        sendCol.add_attribute(this.sendCell, "active", 2);
        this.treeview.append_column(sendCol);
        this.sendCell.connect("toggled", Lang.bind(this, this._editSend));
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        appRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        // Buttons
        let buttonBox = new Gtk.ButtonBox({ halign: Gtk.Align.END });
        appRow.grid.attach(buttonBox, 0, 1, 1, 1);
        
        let removeButton = new Gtk.Button({ label: _("Remove") });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);
        
        this._populate();
        
        this.content.show_all();
    },
    
    _remove: function (button) {
        //
        let [has, model, iter] = this.treeview.get_selection().get_selected();
        
        if (has) {
            let name = this.treeview.model.get_value(iter, 1);
            delete this.settings.send.applications[name];
            this.treeview.model.remove(iter);
        }
    },
    
    _populate: function () {
        let theme = Gtk.IconTheme.get_default()
        
        for (let name in this.settings.send.applications) {
            let pixbuf;
            
            try {
                pixbuf = theme.load_icon(
                    this.settings.send.applications[name].iconName, 0, 0
                );
            } catch (e) {
                pixbuf = theme.load_icon("application-x-executable", 0, 0);
            }
        
            this.treeview.model.set(
                this.treeview.model.append(),
                [0, 1, 2], 
                [pixbuf,
                name,
                this.settings.send.applications[name].enabled]
            );
        }
    },
    
    _editSend: function (renderer, path, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            let enabled = this.treeview.model.get_value(iter, 2);
            this.treeview.model.set_value(iter, 2, !enabled);
            let name = this.treeview.model.get_value(iter, 1);
            this.settings.send.applications[name].enabled = !enabled;
        }
    }
});


