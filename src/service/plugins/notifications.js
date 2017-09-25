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

const { initTranslations, Me, DBusInfo, Settings } = imports.common;
const Config = imports.service.config;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "notifications",
    incomingPackets: ["kdeconnect.notification"],
    outgoingPackets: [
        "kdeconnect.notification.request",
        "kdeconnect.notification.reply"
    ],
    settings: {}
};


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notification
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
        
        if (METADATA.hasOwnProperty("settings")) {
            this.settings = this.device.config.plugins[this.name].settings;
        }
    },
    
    // TODO: consider option for notifications allowing clients to handle them
    handle_packet: function (packet) {
        log("IMPLEMENT: " + packet.toString());
        
        if (packet.body.isCancel && this._notifications.has(packet.body.id)) {
            // Dismissed
            // {"id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114","isCancel":true}
            this._notifications.get(packet.body.id).close();
            this._notifications.delete(packet.body.id);
        } else if (packet.body.hasOwnProperty("time")) {
            // Active
            // {"silent":true,
            //  "requestAnswer":true,
            //  "id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114",
            //  "appName":"KDE Connect",
            //  "isClearable":true,
            //  "ticker":"Failed to send file to Gnome Shell ‐ exject2 (11)",
            //  "time":"1505860630584"}
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: packet.body.time / 1000,
                summary: packet.body.appName,
                body: packet.body.ticker,
                icon_name: "phone-symbolic"
            });
            
            this._notifications.set(packet.body.id, note);
            
            note.connect("closed", Lang.bind(this, this.close, packet.body.id));
            
            note.show();
        } else {
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
        this._freeze = true;
        
        for (let note of this._notifications.values()) {
            note.close();
        }
    
        PluginBase.prototype.destroy.call(this);
    }
});

