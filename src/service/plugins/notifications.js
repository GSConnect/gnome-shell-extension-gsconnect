"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

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

const { initTranslations, Me, DBusInfo, Resources, Settings } = imports.common;
const Config = imports.service.config;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "notifications",
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
            enable: false
        },
        send: {
            enable: false,
            applications: {}
        }
    }
};


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notifications
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sendnotifications
 *
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
        // org.freedesktop.Notifications interface; needed to catch signals
        let iface = "org.freedesktop.Notifications";
        this._ndbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.freedesktop.lookup_interface(iface),
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
        // Signature: str,     uint,       str,      str,     str,  array,   obj,   uint
        log("appName: " + appName);
        log("replacesId: " + replacesId);
        log("iconName: " + iconName);
        log("summary: " + summary);
        log("body: " + body);
        log("actions: " + actions);
        log("hints: " + hints);
        log("timeout: " + timeout);
        
        // New application
        if (!this.settings.send.applications.hasOwnProperty(appName)) {
            this.settings.send.applications[appName] = {
                iconName: iconName,
                enabled: true
            };
//            this.device.configurePlugin(
//                this.name,
//                JSON.stringify(this.settings)
//            );
            Config.write_device_config(this.device.id, this.device.config);
        }
        
        if (this.settings.send.enabled) {
            if (this.settings.send.applications[appName].enabled) {
                // FIXME: forward note here
                // {"silent":true,
                //  "requestAnswer":true,
                //  "id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114",
                //  "appName":"KDE Connect",
                //  "isClearable":true,
                //  "ticker":"Failed to send file to Gnome Shell ‐ exject2 (11)",
                //  "time":"1505860630584"}
                let packet = new Protocol.Packet();
                packet.type = "kdeconnect.notification";
                packet.body = {
                    silent: true,
                    requestAnswer: true,
                    id: replacesId.toString(),
                    appName: appName,
                    isClearable: true,
                    ticker: body,
                    time: Date.now()
                };
                
                this.device._channel.send(packet);
            }
        }
    },
    
    // TODO: consider option for notifications allowing clients to handle them
    handlePacket: function (packet) {
        log("IMPLEMENT: " + packet.toString());
        
        if (packet.type === "kdeconnect.notification" && this.settings.receive.enabled) {
            this._receiveNotification(packet);
        } else if (packet.type === "kdeconnect.notification.request" && this.settings.send.enabled) {
            this._sendNotifications(packet);
        }
    },
    
    _receiveNotification: function (packet) {
        // {"id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114","isCancel":true}
        if (packet.body.isCancel && this._notifications.has(packet.body.id)) {
            this._notifications.get(packet.body.id).close();
            this._notifications.delete(packet.body.id);
            
        // {"silent":true,
        //  "requestAnswer":true,
        //  "id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114",
        //  "appName":"KDE Connect",
        //  "isClearable":true,
        //  "ticker":"Failed to send file to Gnome Shell ‐ exject2 (11)",
        //  "time":"1505860630584"}
        } else if (packet.body.hasOwnProperty("time")) {
            let noteId = Number(packet.body.time.toString().slice(2))
            
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: noteId,
                summary: packet.body.appName,
                body: packet.body.ticker,
                icon_name: "phone-symbolic"
            });
            
            if (!packet.body.silent) {
                log("IMPLEMENT: incoming notification sound?");
            }
            
            if (packet.body.requestAnswer) {
                log("IMPLEMENT: our request is being answered");
            }
            
            if (packet.body.isClearable) {
                note.connect("closed", Lang.bind(this, this.close, packet.body.id));
            }
            
            this._notifications.set(packet.body.id, note);
            
            note.show();
        }
    },
    
    _sendNotifications: function (packet) {
        // Not used...?
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
    
        PluginBase.prototype.destroy.call(this);
    }
});


