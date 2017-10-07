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
const Notify = imports.gi.Notify;

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
            enabled: true,
            sound: false
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
 * FIXME: weird hang, only happens at daemon startup
 * TODO: play sounds when requested
 *       download/upload icons
 *       GNotification?
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
        },
    },
    
    _init: function (device) {
        this.parent(device, "notifications");
        
        this._freeze = false;
        this._notifications = new Map();
    },
    
    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        Common.debug("Notifications: Notify()");
        
        // Signature: str,     uint,       str,      str,     str,  array,   obj,   uint
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
    
    _receiveNotification: function (packet) {
        Common.debug("Notifications: _receiveNotification()");
        
        if (packet.body.isCancel) {
            if (this._notifications.has(packet.body.id)) {
                this._notifications.get(packet.body.id).close();
                this._notifications.delete(packet.body.id);
            }
        } else {
            let notif;
            
            // This is an update to a notification
            if (this._notifications.has(packet.body.id)) {
                notif = this._notifications.get(packet.body.id);
                
                notif.update(
                    packet.body.appName,
                    packet.body.ticker,
                    "phone-symbolic"
                );
            // This is a new notification
            } else {
                notif = new Notify.Notification({
                    app_name: "GSConnect",
                    summary: packet.body.appName,
                    body: packet.body.ticker,
                    icon_name: "phone-symbolic"
                });
            
                if (packet.body.isClearable) {
                    notif.connect(
                        "closed",
                        Lang.bind(this, this.close, packet.body.id)
                    );
                }
            
                if (this.settings.receive.sound) {
                    notif.set_hint(
                        "sound-name",
                        new GLib.Variant("s", "dialog-information")
                    );
                }
                
                this._notifications.set(packet.body.id, notif);
            }
            
            if (packet.body.requestAnswer) {
                Common.debug("Notifications: this is an answer to a request");
            }
            
            /** 
             * Apparently "silent" means don't show the notification...?
             *
             * FIXME: this is sometimes causing a hang and eventual error when
             *        the daemon is starting: Gio.IOErrorEnum: Timeout was reached
             */
            if (!packet.body.silent) {
                notif.show();
            }
        }
    },
    
    close: function (notification, notificationId) {
        if (!this._freeze) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.notification.request";
            packet.body = { cancel: notificationId };
            
            this.device._channel.send(packet);
        }
    },
    
    // TODO: ???
    reply: function () {
    },
    
    // TODO: request notifications
    update: function () {
    },
    
    destroy: function () {
        // Clear notifications
        this._freeze = true;
        
        for (let notif of this._notifications.values()) {
            notif.close();
        }
    
        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectNotificationsSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        // Receiving
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let receiveSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.receive.enabled
        });
        receiveSwitch.connect("notify::active", (widget) => {
            this._settings.receive.enabled = receiveSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Receive Notifications"),
            // TRANSLATORS: eg. Enable to receive notifications from Google Pixel
            _("Enable to receive notifications from %s").format(this._page.device.name),
            receiveSwitch
        );
        
        let soundSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.receive.sound
        });
        soundSwitch.connect("notify::active", (widget) => {
            this._settings.receive.sound = receiveSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Notification Sounds"),
            _("Play a sound when a notification is received"),
            soundSwitch
        );
        
        // Sending
        let sendingSection = this.content.addSection(_("Sending"));
        
        let sendSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.send.enabled
        });
        sendSwitch.connect("notify::active", (widget) => {
            this._settings.send.enabled = sendSwitch.active;
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
            delete this._settings.send.applications[name];
            this.treeview.model.remove(iter);
        }
    },
    
    _populate: function () {
        let theme = Gtk.IconTheme.get_default()
        
        for (let name in this._settings.send.applications) {
            let pixbuf;
            
            try {
                pixbuf = theme.load_icon(
                    this._settings.send.applications[name].iconName, 0, 0
                );
            } catch (e) {
                pixbuf = theme.load_icon("application-x-executable", 0, 0);
            }
        
            this.treeview.model.set(
                this.treeview.model.append(),
                [0, 1, 2], 
                [pixbuf,
                name,
                this._settings.send.applications[name].enabled]
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
            this._settings.send.applications[name].enabled = !enabled;
        }
    }
});


