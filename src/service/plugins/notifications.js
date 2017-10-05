"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
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
    description: _("Sync notifications with other devices"),
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
 * TODO: play sounds when requested
 *       download/upload icons
 *       GNotification?
 *       requestAnswer usage?
 *       urgency filter (outgoing)?
 *       weird hang? maybe stopped happening?
 *       make "shared" notifications clearable
 *       consider option for notifications allowing clients to handle them
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
        
        this._initListener();
    },
    
    _initListener: function () {
        Common.debug("Notifications: _initListener()");
        
        // org.freedesktop.Notifications interface; needed to catch signals
        let iface = "org.freedesktop.Notifications";
        this._ndbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.freedesktop.lookup_interface(iface),
            this
        );
        this._ndbus.export(Gio.DBus.session, "/org/freedesktop/Notifications");
        
        // Subscribe to Notify notifications
        this._callback = Gio.DBus.session.signal_subscribe(
            null,
            "org.freedesktop.Notifications",
            "Notify",
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            Lang.bind(this, this.Notify)
        );
        
        // Match all notifications
        this._match = new GLib.Variant("(s)", ["interface='org.freedesktop.Notifications',member='Notify',type='method_call',eavesdrop='true'"])
        
        this._proxy = new Gio.DBusProxy({
            gConnection: Gio.DBus.session,
            gName: "org.freedesktop.DBus",
            gObjectPath: "/org/freedesktop/DBus",
            gInterfaceName: "org.freedesktop.DBus"
        });
        
        this._proxy.call_sync("AddMatch", this._match, 0, -1, null);
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
                    id: Date.now(),
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
    
    // TODO: consider option for notifications allowing clients to handle them
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
            let note;
            
            if (this._notifications.has(packet.body.id)) {
                note = this._notifications.get(packet.body.id);
                
                note.update(
                    packet.body.appName,
                    packet.body.ticker,
                    "phone-symbolic"
                );
            } else {
                note = new Notify.Notification({
                    app_name: "GSConnect",
                    summary: packet.body.appName,
                    body: packet.body.ticker,
                    icon_name: "phone-symbolic"
                });
            
                if (packet.body.isClearable) {
                    note.connect(
                        "closed",
                        Lang.bind(this, this.close, packet.body.id)
                    );
                }
                
                this._notifications.set(packet.body.id, note);
            }
            
            // TODO: play a sound
            if (!packet.body.silent) {
                Common.debug("Notifications: incoming notification sound");
            }
            
            if (packet.body.requestAnswer) {
                Common.debug("Notifications: our request is being answered");
            }
            
            if (Notify.is_initted()) {
                note.show();
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
        
        for (let note of this._notifications.values()) {
            note.close();
        }
        
        // Shutdown listener
        this._ndbus.unexport();
        this._proxy.call_sync("RemoveMatch", this._match, 0, -1, null);
        Gio.DBus.session.signal_unsubscribe(this._callback);
    
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
            _("Receive notifications"),
            _("Enable to receive notifications from other devices"),
            receiveSwitch
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
            _("Send notifications"),
            _("Enable to send notifications to other devices"),
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


