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
        notify_talking: true,
        pause_music: "never"
    }
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: try and block duplicate "notifications" that match incoming SMS
 *       phoneThumbnail field
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
        
        this._notifications = new Map();
        
        this._pausedPlayer = false;
    },
    
    _handleMissedCall: function (sender, packet) {
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
                app_name: _("GSConnect"),
                // TRANSLATORS: Missed Call
                summary: _("Missed Call"),
                // TRANSLATORS: eg. Missed call from <b>John Smith</b> on <b>Google Pixel</b>
                body: _("Missed call from <b>%s</b> on <b>%s</b>").format(
                    sender,
                    this.device.name
                ),
                icon_name: "call-missed-symbolic"
            });
            
            notif.show();
        }
    },
    
    _handleRinging: function (sender, packet) {
        Common.debug("Telephony: _handleRinging()");
        
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
        
        if (this.settings.notify_ringing) {
            let notif = new Notify.Notification({
                app_name: _("GSConnect"),
                // TRANSLATORS: Incoming Call
                summary: _("Incoming Call").format(this.device.name),
                // TRANSLATORS: eg. Incoming call from <b>John Smith</b> on <b>Google Pixel</b>
                body: _("Incoming call from <b>%s</b> on <b>%s</b>").format(
                    sender,
                    this.device.name
                ),
                icon_name: "call-start-symbolic"
            });
            
            notif.add_action(
                "notify_ringing",
                // TRANSLATORS: Silence an incoming call
                _("Mute"),
                Lang.bind(this, this.muteCall)
            );
            
            notif.show();
        }
        
        if (this.settings.pause_music === "ringing") {
            this._pauseMusic();
        }
    },
    
    _handleSMS: function (sender, packet) {
        Common.debug("Telephony: _handleSMS()");
        
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
                packet.body.phoneThumbnail]
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
                app_name: _("GSConnect"),
                summary: sender,
                body: packet.body.messageBody,
                icon_name: "phone-symbolic"
            });
            
            notif.add_action(
                "notify_sms",
                // TRANSLATORS: Reply to an incoming SMS message
                _("Reply"),
                Lang.bind(this, this.replySms, packet.body)
            );
            
            notif.show();
        }
    },
    
    _handleTalking: function (sender, packet) {
        Common.debug("Telephony: _handleTalking()");
        
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
                app_name: _("GSConnect"),
                // TRANSLATORS: Call In Progress
                summary: _("Call In Progress"),
                // TRANSLATORS: eg. Call in progress with <b>John Smith</b> on <b>Google Pixel</b>
                body: _("Call in progress with <b>%s</b> on <b>%s</b>").format(
                    sender,
                    this.device.name
                ),
                icon_name: "call-start-symbolic"
            });
            
            notif.show();
        }
        
        if (settings.pause_music === "talking") {
            this._pauseMusic();
        }
    },
    
    // FIXME: not always working...?
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
    
    _pauseMusic: function () {
        Common.debug("Telephony: _pauseMusic()");
        
        if (this.device._plugins.has("mpris")) {
            let plugin = this.device._plugins.get("mpris");
            
            for (let player of plugin._players.values()) {
                if (player.PlaybackStatus === "Playing" && player.CanPause) {
                    player.PauseSync();
                    
                    this._pausedPlayer = player;
                }
            }
        }
    },
    
    _unpauseMusic: function () {
        if (this._pausedPlayer) {
            this._pausedPlayer.PlaySync();
            this._pausedPlayer = false;
        }
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
            this._unpauseMusic();
        } else if (packet.body.event === "missedCall") {
            this._handleMissedCall(sender, packet);
        } else if (packet.body.event === "ringing") {
            this._handleRinging(sender, packet);
        } else if (packet.body.event === "sms") {
            this._handleSMS(sender, packet);
        } else if (packet.body.event === "talking") {
            this._handleTalking(sender, packet);
        } else {
            log("Unknown telephony event: " + packet.body.event);
        }
    },
    
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
        
        let win = new SMS.ConversationWindow(this.device.daemon, this.device);
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
            window = new SMS.ConversationWindow(this.device.daemon, this.device);
            
            if (args.contactName.length) {
                window.contactEntry.text = args.contactName + " <" + args.phoneNumber + ">; ";
                window._logIncoming(args.contactName, args.messageBody);
            } else {
                window.contactEntry.text = args.phoneNumber + "; ";
                window._logIncoming(args.phoneNumber, args.messageBody);
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
            id: 0,
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
            _("Missed Call Notification"),
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
            _("Incoming Call Notification"),
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
            _("Call In Progress Notification"),
            _("Show a notification when talking on the phone"),
            notifyTalkingSwitch
        );
        
        let pauseMusicComboBox = new Gtk.ComboBoxText({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        pauseMusicComboBox.append("never", _("Never"));
        pauseMusicComboBox.append("ringing", _("Incoming"));
        pauseMusicComboBox.append("talking", _("In Progress"));
        pauseMusicComboBox.active_id = this._settings.pause_music;
        pauseMusicComboBox.connect("changed", (widget) => {
            this._settings.pause_music = pauseMusicComboBox.active_id;
        });
        this.content.addItem(
            callsSection,
            _("Pause Music"),
            _("Pause music for incoming or in progress calls"),
            pauseMusicComboBox
        );
        if (this._page.device.plugins.indexOf("mpris") < 0) {
            pauseMusicComboBox.sensitive = false;
            pauseMusicComboBox.set_tooltip_markup(
                _("The <b>Media Player Control</b> plugin must be enabled to pause music")
            );
        }
        
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
            _("SMS Notification"),
            _("Show a notification when an SMS message is received"),
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

