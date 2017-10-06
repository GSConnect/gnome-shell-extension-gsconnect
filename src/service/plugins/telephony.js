"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
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

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const SMS = imports.service.plugins.sms;


var METADATA = {
    name: "telephony",
    summary: _("Telephony"),
    description: _("Send and receive SMS and be notified of phone calls"),
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    settings: {
        notify_missedCall: true,
        notify_ringing: true,
        notify_sms: true,
        autoreply_sms: false,
        notify_talking: true
    }
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: try and block duplicate "notifications" that match incoming SMS
 *       notifications
 *       pause music
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        }
    },
    
    _init: function (device) {
        this.parent(device, "telephony");
        
        this._smsNotifications = new Map();
    },
    
    _hasWindow: function (query) {
        Common.debug("Telephony: _hasWindow(" + query + ")");
        
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let window = false;
        
        // Look for an open window that will already be catching messages
        for (let index_ in windows) {
            for (let number of windows[index_].getRecipients().values()) {
                let incomingNumber = query.replace(/\D/g, "");
                let windowNumber = number.replace(/\D/g, "");
                
                if (incomingNumber === windowNumber) {
                    window = windows[index_];
                    break;
                }
            }
            
            if (window !== false) { break; }
        }
        
        return window;
    },
    
    handlePacket: function (packet) {
        Common.debug("Telephony: handlePacket()");
        
        // There are six possible variables:
        //    * "event"             missedCall, ringing, sms or talking
        //    * "phoneNumber"       Always present?
        //    * "contactName"       Always present? (may be empty)
        //    * "messageBody"       SMS only?
        //    * "phoneThumbnail"    base64 ByteArray/Pixmap (may be empty)
        //    * "isCancel"          If true the packet should be ignored
        
        let sender;
        
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
            this.handleMissedCall(sender, packet);
        } else if (packet.body.event === "ringing") {
            this.handleRinging(sender, packet);
        } else if (packet.body.event === "sms") {
            this.handleSMS(sender, packet);
        } else if (packet.body.event === "talking") {
            this.handleTalking(sender, packet);
        } else {
            log("Unknown telephony event: " + packet.body.event);
        }
    },
    
    handleMissedCall: function (sender, packet) {
        Common.debug("Telephony: handleMissedCall()");
        
        this.emit(
            "missedCall",
            packet.body.phoneNumber,
            packet.body.contactName
        );
        this._dbus.emit_signal("missedCall",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        if (this.settings.notify_missedCall) {
            let notif = new Notify.Notification({
                app_name: "GSConnect",
                summary: _("%s - Missed Call").format(this.device.name),
                body: _("Missed call from %s").format(sender),
                icon_name: "call-missed-symbolic"
            });
            
            notif.show();
        }
    },
    
    handleRinging: function (sender, packet) {
        Common.debug("Telephony: handleRinging()");
        
        this.emit(
            "ringing",  
            packet.body.phoneNumber,    
            packet.body.contactName
        );
        this._dbus.emit_signal("ringing",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        // TODO: music pause, etc
        if (this.settings.notify_ringing) {
            let notif = new Notify.Notification({
                app_name: "GSConnect",
                summary: _("%s Ringing").format(this.device.name),
                body: _("Incoming call from %s").format(sender),
                icon_name: "call-start-symbolic"
            });
            
            notif.add_action(
                "notify_ringing",
                _("Mute"),
                Lang.bind(this, this.mute)
            );
            
            notif.show();
        }
    },
    
    handleSMS: function (sender, packet) {
        Common.debug("Telephony: handleSMS()");
        
        this.emit(
            "sms",
            packet.body.phoneNumber,
            packet.body.contactName,
            packet.body.messageBody,
            packet.body.phoneThumbnail
        );
        
        this._dbus.emit_signal("sms",
            new GLib.Variant(
                "(ssss)",
                [packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.messageBody,
                packet.body.phoneThumbnail] // FIXME: bytearray.pixmap ???
            )
        );
        
        // FIXME: urgency
        //        block matching notification somehow?
        //        category...?
        //        track notifs, append new messages to unclosed..
        if (this.settings.autoreply_sms) {
            this.replySms(null, "autoreply_sms", packet.body);
        } else if (this.settings.notify_sms) {
            let notif = new Notify.Notification({
                app_name: "GSConnect",
                summary: sender,
                body: packet.body.messageBody,
                icon_name: "phone-symbolic"
            });
            
            notif.add_action(
                "notify_sms", // action char
                _("Reply"), // label
                Lang.bind(this, this.replySms, packet.body)
            );
            
            notif.show();
        }
    },
    
    handleTalking: function (sender, packet) {
        Common.debug("Telephony: handleTalking()");
        
        // TODO: music pause, etc
        this.emit(
            "talking",
            packet.body.phoneNumber,
            packet.body.contactName
        );
        this._dbus.emit_signal("talking",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        if (this.settings.notify_talking) {
            notif = new Notify.Notification({
                app_name: "GSConnect",
                summary: _("%s - Talking").format(this.device.name),
                body: _("Call in progress with %s").format(sender),
                icon_name: "call-start-symbolic"
            });
            
            notif.show();
        }
    },
    
    // TODO: test
    muteCall: function () {
        Common.debug("Telephony: muteCall()");
        
        let packet = new Protocol.Packet();
        packet.type = "kdeconnect.telephony.request"
        packet.body = { action: "mute" };
        this.device._channel.send(packet);
    },
    
    /**
     * Open and present a new SMS window
     */
    openSms: function () {
        Common.debug("Telephony: openSms()");
        
        let win = new SMS.ApplicationWindow(this.device.daemon, this.device);
        win.present();
    },
    
    /**
     * Either open a new SMS window for the sender or reuse an existing one
     *
     * @param {Notify.Notification} notif - The notification that called this
     * @param {string} action - The notification action that called this
     * @param {object} args - The body of the received packet that called this
     */
    replySms: function (notif, action, args) {
        Common.debug("Telephony: replySms()");
        
        // Check for an extant window
        let window = this._hasWindow(args.phoneNumber);
        
        // None found, open a new one, add the contact and log the message
        if (!window) {
            window = new SMS.ApplicationWindow(this.device.daemon, this.device);
            
            if (args.contactName.length) {
                window.contactEntry.text = args.contactName + " <" + args.phoneNumber + ">; ";
                window._log_message(args.contactName, args.messageBody);
            } else {
                window.contactEntry.text = args.phoneNumber + "; ";
                window._log_message(args.phoneNumber, args.messageBody);
            }
        }
        
        // Present the window
        window.present();
    },
    
    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms: function (phoneNumber, messageBody) {
        Common.debug("Telephony: sendSms(" + phoneNumber + ", " + messageBody + ")");
        
        let packet = new Protocol.Packet({
            id: Date.now(),
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });
        
        this.device._channel.send(packet);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectTelephonySettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        // Phone Calls
        let callsSection = this.content.addSection(_("Phone Calls"));
        
        let notifyMissedCallSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_missedCall
        });
        notifyMissedCallSwitch.connect("notify::active", (widget) => {
            this._settings.notify_missedCall = notifyMissedCallSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Missed call notification"),
            _("Show a notification for missed calls"),
            notifyMissedCallSwitch
        );
        
        let notifyRingingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_ringing
        });
        notifyRingingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_ringing = notifyRingingSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Ringing notification"),
            _("Show a notification when the phone is ringing"),
            notifyRingingSwitch
        );
        
        let notifyTalkingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_talking
        });
        notifyTalkingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_talking = notifyTalkingSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Talking notification"),
            _("Show a notification when talking on the phone"),
            notifyTalkingSwitch
        );
        
        // SMS
        let smsSection = this.content.addSection(_("SMS"));
        
        let notifySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_sms
        });
        notifySMSSwitch.connect("notify::active", (widget) => {
            this._settings.notify_sms = notifySMSSwitch.active;
        });
        this.content.addItem(
            smsSection,
            _("SMS notification"),
            _("Show a notification when an SMS is received"),
            notifySMSSwitch
        );
        
        let autoreplySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.autoreply_sms
        });
        autoreplySMSSwitch.connect("notify::active", (widget) => {
            this._settings.autoreply_sms = autoreplySMSSwitch.active;
        });
        this.content.addItem(
            smsSection,
            _("Autoreply to SMS"),
            _("Open a new SMS window when an SMS is received"),
            autoreplySMSSwitch
        );
        
        this.content.show_all();
    }
});

