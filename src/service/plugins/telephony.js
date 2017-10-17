"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

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
const SMS = imports.service.plugins.sms;


var METADATA = {
    name: "telephony",
    summary: _("Telephony"),
    description: _("Send and receive SMS and be notified of phone calls"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Telephony-Plugin",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    settings: {
        notify_missedCall: true,
        notify_ringing: true,
        notify_sms: true,
        notify_talking: true,
        pause_music: "never"
    }
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: phoneThumbnail field
 *       notification urgency
 *       track notifs, append new messages to unclosed..?
 *       mute: pactl set-sink-mute @DEFAULT_SINK@ 1
 *       unmute: pactl set-sink-mute @DEFAULT_SINK@ 1
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
            let notif = new Gio.Notification();
            // TRANSLATORS: Missed Call
            notif.set_title(_("Missed Call"));
            notif.set_body(
                // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
                _("Missed call from %s on %s").format(
                    sender,
                    this.device.name
                )
            );
            notif.set_icon(new Gio.ThemedIcon({ name: "call-missed-symbolic" }));
            notif.set_priority(Gio.NotificationPriority.NORMAL);
            
            this.device.daemon.send_notification(packet.id.toString(), notif);
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
            let notif = new Gio.Notification();
            // TRANSLATORS: Incoming Call
            notif.set_title(_("Incoming Call"));
            notif.set_body(
                // TRANSLATORS: eg. Incoming call from John Smith on Google Pixel
                _("Incoming call from %s on %s").format(
                    sender,
                    this.device.name
                )
            );
            notif.set_icon(new Gio.ThemedIcon({ name: "call-start-symbolic" }));
            notif.set_priority(Gio.NotificationPriority.URGENT);
            
            notif.add_button(
                // TRANSLATORS: Silence an incoming call
                _("Mute"),
                "app.muteCall('" + this._dbus.get_object_path() + "')"
            );
            
            this.device.daemon.send_notification(packet.id.toString(), notif);
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
        
        // Check for an extant window
        let window = this._hasWindow(packet.body.phoneNumber);
        
        if (window) {
            window._logIncoming(sender, packet.body.messageBody);
            window.urgency_hint = true;
            
            // Tell the notifications plugin to mark any duplicate read
            if (this.device._plugins.has("notifications")) {
                this.device._plugins.get("notifications").markReadSms(
                    sender + ": " + packet.body.messageBody
                );
            }
        }
        
        if (this.settings.notify_sms) {
            let notif = new Gio.Notification();
            notif.set_title(sender);
            notif.set_body(packet.body.messageBody);
            notif.set_icon(new Gio.ThemedIcon({ name: "sms-symbolic" }));
            notif.set_priority(Gio.NotificationPriority.HIGH);
            
            notif.add_button(
                // TRANSLATORS: Reply to a received SMS message
                _("Reply"),
                "app.replySms(('" +
                this._dbus.get_object_path() +
                "','" +
                packet.body.phoneNumber +
                "','" +
                packet.body.contactName +
                "','" +
                packet.body.messageBody +
                "','" +
                packet.body.phoneThumbnail +
                "'))"
            );
            
            // Tell the notifications plugin to "silence" any duplicate
            if (this.device._plugins.has("notifications")) {
                this.device._plugins.get("notifications").silenceSms(
                    sender + ": " + packet.body.messageBody
                );
            }
            
            this.device.daemon.send_notification(packet.id.toString(), notif);
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
            let notif = new Gio.Notification();
            // TRANSLATORS: Talking on the phone
            notif.set_title(_("Call In Progress"));
            notif.set_body(
                // TRANSLATORS: eg. Call in progress with John Smith on Google Pixel
                _("Call in progress with %s on %s").format(
                    sender,
                    this.device.name
                )
            );
            notif.set_icon(new Gio.ThemedIcon({ name: "call-start-symbolic" }));
            notif.set_priority(Gio.NotificationPriority.NORMAL);
            
            this.device.daemon.send_notification(packet.id.toString(), notif);
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
        //    * "isCancel"          The event has been cancelled
        
        let sender;
        
         // FIXME: not sure what to do here; this complicates all the other
         //        logic performed on these variables
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
    
    /**
     * Silence an incoming call
     */
    muteCall: function () {
        Common.debug("Telephony: muteCall()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.telephony.request",
            body: { action: "mute" }
        });
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
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} messageBody - The SMS message
     * @param {string} phoneThumbnail - The sender's avatar (pixmap bytearray)
     */
    replySms: function (phoneNumber, contactName, messageBody, phoneThumbnail) {
        Common.debug("Telephony: replySms()");
        
        // Check for an extant window
        let window = this._hasWindow(phoneNumber);
        
        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new SMS.ConversationWindow(this.device.daemon, this.device);
        
            if (contactName.length) {
                window.contactEntry.text = contactName + " <" + phoneNumber + ">; ";
                window._logIncoming(contactName, messageBody);
            } else {
                window.contactEntry.text = phoneNumber + "; ";
                window._logIncoming(phoneNumber, messageBody);
            }
            
            window.urgency_hint = true;
            
            // Tell the notifications plugin to mark any duplicate read
            let sender = (contactName.length) ? contactName : phoneNumber;
            
            if (this.device._plugins.has("notifications")) {
                this.device._plugins.get("notifications").markReadSms(
                    sender + ": " + messageBody
                );
            }
        }
        
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
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        // Phone Calls
        let callsSection = this.content.addSection(_("Phone Calls"));
        
        let notifyMissedCallSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.notify_missedCall
        });
        notifyMissedCallSwitch.connect("notify::active", (widget) => {
            this.settings.notify_missedCall = notifyMissedCallSwitch.active;
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
            active: this.settings.notify_ringing
        });
        notifyRingingSwitch.connect("notify::active", (widget) => {
            this.settings.notify_ringing = notifyRingingSwitch.active;
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
            active: this.settings.notify_talking
        });
        notifyTalkingSwitch.connect("notify::active", (widget) => {
            this.settings.notify_talking = notifyTalkingSwitch.active;
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
        pauseMusicComboBox.active_id = this.settings.pause_music;
        pauseMusicComboBox.connect("changed", (widget) => {
            this.settings.pause_music = pauseMusicComboBox.active_id;
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
            active: this.settings.notify_sms
        });
        notifySMSSwitch.connect("notify::active", (widget) => {
            this.settings.notify_sms = notifySMSSwitch.active;
        });
        this.content.addItem(
            smsSection,
            _("SMS Notification"),
            _("Show a notification when an SMS message is received"),
            notifySMSSwitch
        );
        
        this.content.show_all();
    }
});

