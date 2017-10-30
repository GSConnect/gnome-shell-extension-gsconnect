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
const TelephonyWidget = imports.widgets.telephony;


var METADATA = {
    summary: _("Telephony"),
    description: _("Call notification and SMS messaging"),
    dbusInterface: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    schemaId: "org.gnome.shell.extensions.gsconnect.plugin.telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"]
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: phoneThumbnail's are super small in notifications :(
 *       track notifs: isCancel events, append new messages to unacknowledged?
 *       mute/unmute: pactl set-sink-mute @DEFAULT_SINK@ 1/0
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
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
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
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
            packet.body.contactName,
            packet.body.phoneThumbnail
        );
        this._dbus.emit_signal("missedCall",
            new GLib.Variant(
                "(sss)",
                [packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.phoneThumbnail]
            )
        );
        
        if (this.settings.get_boolean("missed-call-notification")) {
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
            if (packet.body.phoneThumbnail) {
                let bytes = GLib.base64_decode(packet.body.phoneThumbnail);
                notif.set_icon(Gio.BytesIcon.new(bytes));
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "call-missed-symbolic" }));
            }
            notif.set_priority(Gio.NotificationPriority.NORMAL);
            
            notif.add_button(
                // TRANSLATORS: Reply to a missed call by SMS
                _("Message"),
                "app.replyMissedCall(('" +
                this._dbus.get_object_path() +
                "','" +
                escape(packet.body.phoneNumber) +
                "','" +
                escape(packet.body.contactName) +
                "','" +
                packet.body.phoneThumbnail +
                "'))"
            );
            
            // Tell the notification plugin to "silence" any duplicate
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").silenceDuplicate(
                    // TRANSLATORS: This is specifically for matching missed call notifications on Android.
                    // You should translate this (or not) to match the string on your phone that in english looks like "Missed call: John Lennon"
                    _("Missed call") + ": " + sender
                );
            }
            
            this.device.daemon.send_notification(
                _("Missed call") + ": " + sender,
                notif
            );
        }
    },
    
    _handleRinging: function (sender, packet) {
        Common.debug("Telephony: _handleRinging()");
        
        this.emit(
            "ringing",  
            packet.body.phoneNumber,    
            packet.body.contactName,
            packet.body.phoneThumbnail
        );
        this._dbus.emit_signal("ringing",
            new GLib.Variant(
                "(sss)",
                [packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.phoneThumbnail]
            )
        );
        
        if (this.settings.get_boolean("ringing-notification")) {
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
            if (packet.body.phoneThumbnail) {
                let bytes = GLib.base64_decode(packet.body.phoneThumbnail);
                notif.set_icon(Gio.BytesIcon.new(bytes));
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "call-start-symbolic" }));
            }
            notif.set_priority(Gio.NotificationPriority.URGENT);
            
            notif.add_button(
                // TRANSLATORS: Silence an incoming call
                _("Mute"),
                "app.muteCall('" + this._dbus.get_object_path() + "')"
            );
            
            this.device.daemon.send_notification(
                packet.body.event + ":" + packet.body.phoneNumber,
                notif
            );
        }
        
        if (this.settings.get_string("pause-music") === "ringing") {
            this._pauseMusic();
        }
    },
    
    _handleSms: function (sender, packet) {
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
            window.receive(
                packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.messageBody,
                packet.body.phoneThumbnail
            );
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    sender + ": " + packet.body.messageBody
                );
            }
        }
        
        if (this.settings.get_boolean("sms-notification")) {
            let notif = new Gio.Notification();
            notif.set_title(sender);
            notif.set_body(packet.body.messageBody);
            if (packet.body.phoneThumbnail) {
                let bytes = GLib.base64_decode(packet.body.phoneThumbnail);
                notif.set_icon(Gio.BytesIcon.new(bytes));
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "sms-symbolic" }));
            }
            notif.set_priority(Gio.NotificationPriority.HIGH);
            
            notif.set_default_action(
                "app.replySms(('" +
                this._dbus.get_object_path() +
                "','" +
                escape(packet.body.phoneNumber) +
                "','" +
                escape(packet.body.contactName) +
                "','" +
                escape(packet.body.messageBody) +
                "','" +
                packet.body.phoneThumbnail +
                "'))"
            );
            
            // Tell the notification plugin to "silence" any duplicate
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").silenceDuplicate(
                    sender + ": " + packet.body.messageBody
                );
            }
            
            this.device.daemon.send_notification(packet.id.toString(), notif);
            
            if (window) {
                window._notifications.push(packet.id.toString());
            }
        }
    },
    
    _handleTalking: function (sender, packet) {
        Common.debug("Telephony: _handleTalking()");
        
        this.emit(
            "talking",
            packet.body.phoneNumber,
            packet.body.contactName,
            packet.body.phoneThumbnail
        );
        this._dbus.emit_signal("talking",
            new GLib.Variant(
                "(sss)",
                [packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.phoneThumbnail]
            )
        );
        
        if (this.settings.get_boolean("talking-notification")) {
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
            if (packet.body.phoneThumbnail) {
                let bytes = GLib.base64_decode(packet.body.phoneThumbnail);
                notif.set_icon(Gio.BytesIcon.new(bytes));
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "call-start-symbolic" }));
            }
            notif.set_priority(Gio.NotificationPriority.NORMAL);
            
            this.device.daemon.send_notification(
                packet.body.event + ":" + packet.body.phoneNumber,
                notif
            );
        }
        
        if (this.settings.get_string("pause-music") === "talking") {
            this._pauseMusic();
        }
    },
    
    // FIXME: not always working...?
    _hasWindow: function (phoneNumber) {
        Common.debug("Telephony: _hasWindow(" + phoneNumber + ")");
        
        let incomingNumber = phoneNumber.replace(/\D/g, "");
        
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let window = false;
        
        // Look for an open window that will already be catching messages
        for (let index_ in windows) {
            for (let windowNumber of windows[index_].recipients) {
                
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
        
        // Ensure our signal emissions don't choke, but leave them falsey
        packet.body.contactName = packet.body.contactName || "";
        packet.body.phoneNumber = packet.body.phoneNumber || "";
        packet.body.phoneThumbnail = packet.body.phoneThumbnail || "";
        
        let sender;
                
        if (packet.body.contactName) {
            sender = packet.body.contactName;
        } else if (packet.body.phoneNumber) {
            sender = packet.body.phoneNumber;
        } else {
            sender = _("Unknown Number");
        }
        
        // Event handling
        // FIXME: unpause for correct event
        if (packet.body.isCancel) {
            this._unpauseMusic();
            this.device.daemon.withdraw_notification(
                packet.body.event + ":" + packet.body.phoneNumber
            );
        } else if (packet.body.event === "missedCall") {
            this._handleMissedCall(sender, packet);
        } else if (packet.body.event === "ringing") {
            this._handleRinging(sender, packet);
        } else if (packet.body.event === "sms") {
            this._handleSms(sender, packet);
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
        
        let window = new TelephonyWidget.ConversationWindow(
            this.device.daemon,
            this.device
        );
        window.present();
    },
    
    /**
     * Either open a new SMS window for the caller or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} phoneThumbnail - The sender's avatar (pixmap bytearray)
     */
    replyMissedCall: function (phoneNumber, contactName, phoneThumbnail) {
        Common.debug("Telephony: replyMissedCall()");
        
        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);
        
        // Check for an extant window
        let window = this._hasWindow(phoneNumber);
        
        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(
                this.device.daemon,
                this.device
            );
            window.addRecipient(
                phoneNumber,
                contactName,
                phoneThumbnail
            );
            
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    _("Missed call") + ": " + contactName || phoneNumber
                );
            }
        }
        
        window.present();
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
        
        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);
        messageBody = unescape(messageBody);
        
        // Check for an extant window
        let window = this._hasWindow(phoneNumber);
        
        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(
                this.device.daemon,
                this.device
            );
            
            window.receive(
                phoneNumber,
                contactName,
                messageBody,
                phoneThumbnail
            );
            
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    contactName || phoneNumber + ": " + messageBody
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
    
    _init: function (device, name, window) {
        this.parent(device, name, window);
        
        let notificationSection = this.content.addSection(
            _("Notifications"),
            null,
            { width_request: -1 }
        );
        
        notificationSection.addGSetting(this.settings, "missed-call-notification");
        notificationSection.addGSetting(this.settings, "ringing-notification");
        notificationSection.addGSetting(this.settings, "talking-notification");
        notificationSection.addGSetting(this.settings, "sms-notification");
        
        let mediaSection = this.content.addSection(
            _("Media"),
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        
        let pauseMusicComboBox = new Gtk.ComboBoxText({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        pauseMusicComboBox.append("never", _("Never"));
        pauseMusicComboBox.append("ringing", _("Incoming Calls"));
        pauseMusicComboBox.append("talking", _("In Progress Calls"));
        this.settings.bind(
            "pause-music",
            pauseMusicComboBox,
            "active-id",
            Gio.SettingsBindFlags.DEFAULT
        );
        mediaSection.addSetting(_("Pause Music"), null, pauseMusicComboBox);
        
        if (this.device.plugins.indexOf("mpris") < 0) {
            pauseMusicComboBox.sensitive = false;
            pauseMusicComboBox.set_tooltip_markup(
                _("The <b>Media Player Control</b> plugin must be enabled")
            );
        }
        
        this.content.show_all();
    }
});

