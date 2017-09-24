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
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const PluginsBase = imports.plugins.base;

const Config = imports.service.config;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


var METADATA = {
    name: "telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    settings: {}
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "telephony");
        
        if (METADATA.hasOwnProperty("settings")) {
            this.settings = this.device.config.plugins[this.name].settings;
        }
    },
    
    get incomingPackets() {
        return ["kdeconnect.telephony"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.telephony.request", "kdeconnect.sms.request"];
    },
    
    // TODO
    handle_packet: function (packet) {
        // There are six possible variables:
        //    * "event"             missedCall, ringing, sms or talking
        //    * "phoneNumber"       Always present?
        //    * "contactName"       Always present? (may be empty)
        //    * "messageBody"       SMS only?
        //    * "phoneThumbnail"    base64 ByteArray/Pixmap (may be empty)
        //    * "isCancel"          If true the packet should be ignored
        
        let sender, note;
        
         // FIXME: not sure what to do here...
//        if (!packet.body.phoneNumber.length) {
//            packet.body.phoneNumber = _("Unknown Number");
//        }
//        
//        if (packet.body.contactName === "") {
//            packet.body.contactName = _("Unknown Contact");
//        }
                
        if (packet.body.contactName.length) {
            sender = packet.body.contactName;
        } else {
            sender = packet.body.phoneNumber;
        }
        
        // Event handling
        if (packet.body.hasOwnProperty("isCancel") && packet.body.isCancel) {
            return;
        } else if (packet.body.event === "missedCall") {
            this._dbus.emit_signal("missedCall",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_missedCall) {
                note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s - Missed Call").format(this.device.name),
                    body: _("Missed call from %s").format(sender),
                    icon_name: "call-missed-symbolic"
                });
                
                note.show();
            }
        } else if (packet.body.event === "ringing") {
            this._dbus.emit_signal("ringing",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_ringing) {
                let note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s Ringing").format(this.device.name),
                    body: _("Incoming call from %s").format(sender),
                    icon_name: "call-start-symbolic"
                });
                
                note.add_action(
                    "notify_sms",
                    _("Mute"),
                    Lang.bind(this, this.mute)
                );
                
                note.show();
            }
        // TODO: not really complete
        } else if (packet.body.event === "sms") {
            this._dbus.emit_signal("sms",
                new GLib.Variant(
                    "(ssss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName,
                    packet.body.messageBody,
                    packet.body.phoneThumbnail] // FIXME: bytearray.pixmap
                )
            );
            
            // FIXME: check for open window
            //        urgency
            //        block matching notification somehow?
            if (this.settings.autoreply_sms) {
                this.reply(null, "autoreply_sms", packet.body);
            } else if (this.settings.notify_sms) {
                let sender;
                
                if (packet.body.contactName !== "") {
                    sender = packet.body.contactName;
                } else {
                    sender = packet.body.phoneNumber;
                }
            
                let note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: sender,
                    body: packet.body.messageBody,
                    icon_name: "phone-symbolic"
                });
                
                note.add_action(
                    "notify_sms", // action char
                    _("Reply"), // label
                    Lang.bind(this, this.reply, packet.body)
                );
                
                note.show();
            }
            
        } else if (packet.body.event === "talking") {
            this._dbus.emit_signal("talking",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_talking) {
                note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s - Talking").format(this.device.name),
                    body: _("Call in progress with %s").format(sender),
                    icon_name: "call-start-symbolic"
                });
                
                note.show();
            }
        } else {
            log("Unknown telephony event: " + packet.body.event);
        }
    },
    
    // TODO: test, but how? no one calls me!
    mute: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.telephony.request"
            packet.body = { action: "mute" };
            this.device._channel.send(packet);
        }
    },
    
    reply: function (notification, action, user_data) {
        log("TelephonyPlugin._open_sms()");
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/sms.js --device=" + this.device.id
        );
    },
    
    sms: function (phoneNumber, messageBody) {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.sms.request";
            
            packet.body = {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            };
            
            this.device._channel.send(packet);
        }
    }
});
