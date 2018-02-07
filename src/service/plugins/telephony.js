"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Contacts = imports.modules.contacts;
const Sound = imports.modules.sound;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const TelephonyWidget = imports.widgets.telephony;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"]
};


var UUID = "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony";

var IncomingPacket = {
    TELEPHONY_EVENT: "kdeconnect.telephony"
};

var OutgoingPacket = {
    TELEPHONY_ACTION: "kdeconnect.telephony.request",
    SMS_MESSAGE: "kdeconnect.sms.request"
};

var Action = {
    openSms: {
        label: _("Reply to a missed call by SMS"),
        incoming: ["kdeconnect.telephony"],
        outgoing: ["kdeconnect.sms.request"]
    },
    replyMissedCall: {
        label: _("Reply to a missed call by SMS"),
        incoming: ["kdeconnect.telephony"],
        outgoing: ["kdeconnect.sms.request"]
    },
    replySms: {
        label: _("Reply to an SMS"),
        incoming: ["kdeconnect.telephony"],
        outgoing: ["kdeconnect.sms.request"]
    },
    sendSms: {
        label: _("Reply to a missed call by SMS"),
        incoming: ["kdeconnect.telephony"],
        outgoing: ["kdeconnect.sms.request"]
    }
};


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces,
 * allowing passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
let _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
let _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
let _lenientDigits = "[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+";
let _lenientNumber = _lenientDigits + "(?:" + _telParam + ")*";

var _smsRegex = new RegExp(
    "^" +
    "sms:" +                                // scheme
    "(?:[/]{2,3})?" +                       // Gio.File returns ":///"
    "(" +                                   // one or more...
        _lenientNumber +                    // phone numbers
        "(?:," + _lenientNumber + ")*" +    // separated by commas
    ")" +
    "(?:\\?(" +                             // followed by optional...
        _smsParam +                         // parameters...
        "(?:&" + _smsParam + ")*" +         // separated by "&" (unescaped)
    "))?" +
    "$", "g");                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    "^" +
    "(" + _lenientDigits + ")" +            // phone number digits
    "((?:" + _telParam + ")*)" +            // followed by optional parameters
    "$", "g");


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * Packets:
 *  {
 *      type: "kdeconnect.telephony"
 *      id: {Number microseconds timestamp}
 *      body: {
 *          event: {String} missedCall | ringing | sms | talking,
 *          [contactName]: {String} Sender's name (optional),
 *          phoneNumber: {String} Sender's phone number (mandatory?),
 *          [messageBody]: {String} SMS message body (mandatory for 'sms' events),
 *          [phoneThumbnail]: {String} base64 encoded JPEG bytes,
 *          [isCancel]: {Boolean} Marks the end of a 'ringing'/'talking' event
 *      }
 *  }
 *
 *
 * TODO: track notifs: isCancel events, append new messages to unacknowledged?
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        }
    },

    _init: function (device) {
        this.parent(device, "telephony");

        this.contacts = Contacts.getStore();
    },

    // FIXME: use contact cache
    handlePacket: function (packet) {
        debug(packet);

        let event = this._parsePacket(packet);

        // Event handling
        // The event has ended (ringing stopped or call ended)
        if (event.isCancel) {
            this._resumeMedia();
            this._unmuteMicrophone();
            this._restoreVolume();
            this.device.withdraw_notification(event.event + "|" + event.contact.name); // FIXME
        // An event was triggered
        } else {
            // SMS Message (sms)
            if (event.event === "sms") {
                this.emit(
                    "sms",
                    event.phoneNumber,
                    event.contact.name,
                    event.messageBody,
                    event.contact.avatar || ""
                );

                this._dbus.emit_signal("sms",
                    new GLib.Variant(
                        "(ssss)",
                        [event.phoneNumber,
                        event.contact.name,
                        event.messageBody,
                        event.contact.avatar || ""]
                    )
                );

                return new Promise((resolve, reject) => {
                    if (this.settings.get_boolean("handle-messaging")) {
                        resolve(this._onSms(event));
                    } else {
                        reject(false);
                    }
                });
            // Phone Call (missedCall | ringing | talking)
            } else {
                this.emit(
                    event.event,
                    event.contact.number,
                    event.contact.name,
                    event.contact.avatar || ""
                );
                this._dbus.emit_signal(event.event,
                    new GLib.Variant(
                        "(sss)",
                        [event.contact.number,
                        event.contact.name,
                        event.contact.avatar || ""]
                    )
                );

                return new Promise((resolve, reject) => {
                    if (this.settings.get_boolean("handle-calls")) {
                        switch (event.event) {
                            case "missedCall":
                                resolve(this._onMissedCall(event));
                                break;
                            case "ringing":
                                resolve(this._onRinging(event));
                                break;
                            case "missedCall":
                                resolve(this._onTalking(event));
                                break;
                            default:
                                log("Unknown telephony event");
                                reject(false);
                        }
                    } else {
                        reject(false);
                    }
                });
            }
        }
    },

    /**
     * Parse an telephony packet and return an event object, with ... TODO
     *
     * @param {object} packet - A telephony event packet
     * @return {object} - Aa event object
     */
    _parsePacket: function (packet) {
        let event = packet.body;
        event.time = GLib.DateTime.new_now_local().to_unix();

        event.contact = this.contacts.getContact(
            event.contactName,
            event.phoneNumber
        );

        // Update contact avatar
        // FIXME: move to modules/contacts.js
        if (event.phoneThumbnail) {
            if (!event.contact.avatar) {
                debug("updating avatar for " + event.contact.name);

                let path = this.contacts._cacheDir + "/" + GLib.uuid_string_random() + ".jpeg";
                GLib.file_set_contents(
                    path,
                    GLib.base64_decode(event.phoneThumbnail)
                );
                event.contact.avatar = path;
                this.contacts._writeCache();
            }

            delete event.phoneThumbnail;
        }

        // Set an icon appropriate for the event
        if (event.contact.avatar) {
            event.gicon = this.contacts.getContactPixbuf(event.contact.avatar);
        } else if (event.event === "missedCall") {
            event.gicon = new Gio.ThemedIcon({ name: "call-missed-symbolic" });
        } else if (["ringing", "talking"].indexOf(event.event) > -1) {
            event.gicon = new Gio.ThemedIcon({ name: "call-start-symbolic" });
        } else if (event.event === "sms") {
            event.gicon = new Gio.ThemedIcon({ name: "sms-symbolic" });
        }

        return event;
    },

    /**
     * Telephony event handlers
     */
    _onMissedCall: function (event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get("notification");

        if (notification) {
            // TRANSLATORS: This is specifically for matching missed call notifications on Android.
            // You should translate this to match the notification on your phone that in english looks like "Missed call: John Lennon"
            notification.markDuplicate({
                localId: "missedCall|" + event.time,
                ticker: _("Missed call") + ": " + event.contact.name,
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.phoneNumber);

        if (window) {
            // FIXME: log the missed call in the window
            window.receiveMessage(
                event.contact,
                event.phoneNumber,
                "<i>" + _("Missed call at %s").format(event.time) + "</i>"
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.event,
                event.contact.name + ": " + event.messageBody
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: "missedCall|" + event.time,
                    ticker: event.contact.name + ": " + event.messageBody,
                    isCancel: true
                });
            }
        }

        let notif = new Gio.Notification();
        // TRANSLATORS: Missed Call
        notif.set_title(_("Missed Call"));
        notif.set_body(
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            _("Missed call from %s on %s").format(
                event.contact.name,
                this.device.name
            )
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.NORMAL);

        notif.add_device_button(
            // TRANSLATORS: Reply to a missed call by SMS
            _("Message"),
            this._dbus.get_object_path(),
            "replyMissedCall",
            [event.phoneNumber, event.contact.name, event.time]
        );

        this.device.send_notification(
            event.event + "|" + _("Missed call") + ": " + event.contact.name,
            notif
        );

        return true;
    },

    _onRinging: function (event) {
        debug(event);

        let notif = new Gio.Notification();
        // TRANSLATORS: Incoming Call
        notif.set_title(_("Incoming Call"));
        notif.set_body(
            // TRANSLATORS: eg. Incoming call from John Smith on Google Pixel
            _("Incoming call from %s on %s").format(event.contact.name, this.device.name)
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.URGENT);

        notif.add_device_button(
            // TRANSLATORS: Silence an incoming call
            _("Mute"),
            this._dbus.get_object_path(),
            "muteCall"
        );

        this.device.send_notification(event.event + "|" + event.contact.name, notif);

        // FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME
        this._adjustVolume(this.settings.get_string("ringing-volume"));
        this._pauseMedia(this.settings.get_boolean("ringing-pause"));

        return true;
    },

    _onSms: function (event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get("notification");

        if (notification) {
            notification.markDuplicate({
                localId: "sms|" + event.time,
                ticker: event.contact.name + ": " + event.messageBody
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.phoneNumber);

        if (window) {
            window.receiveMessage(
                event.contact,
                event.phoneNumber,
                event.messageBody
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.event,
                event.contact.name + ": " + event.messageBody
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: "sms|" + event.time,
                    ticker: event.contact.name + ": " + event.messageBody,
                    isCancel: true
                });
            }
        }

        let notif = new Gio.Notification();
        notif.set_title(event.contact.name);
        notif.set_body(event.messageBody);
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.HIGH);

        notif.set_device_action(
            this._dbus.get_object_path(),
            "replySms",
            [event.phoneNumber,
            event.contact.name,
            event.messageBody,
            event.time]
        );

        this.device.send_notification(
            event.event + "|"  + event.contact.name + ": " + event.messageBody,
            notif
        );

        return true;
    },

    _onTalking: function (event) {
        debug(event);

        // TODO: need this, or done by isCancel?
        this.device.withdraw_notification("ringing|" + event.contact.name);

        let notif = new Gio.Notification();
        // TRANSLATORS: Talking on the phone
        notif.set_title(_("Call In Progress"));
        notif.set_body(
            // TRANSLATORS: eg. Call in progress with John Smith on Google Pixel
            _("Call in progress with %s on %s").format(
                event.contact.name,
                this.device.name
            )
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.NORMAL);

        this.device.send_notification(
            event.event + "|" + event.contact.name,
            notif
        );

        // FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME
        this._adjustVolume(this.settings.get_string("talking-volume"));
        this._muteMicrophone(this.settings.get_boolean("talking-microphone"));
        this._pauseMedia(this.settings.get_boolean("talking-pause"));

        return true;
    },

    /**
     * Check if there's an open conversation for a number(s)
     *
     * @param {string|array} phoneNumber - A string phone number or array of
     */
    _hasWindow: function (number) {
        debug(number);

        number = number.replace(/\D/g, "");

        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let conversation = false;

        // Look for an open window with this contact
        for (let index_ in windows) {
            let win = windows[index_];

            if (!win.device || win.device.id !== this.device.id) {
                continue;
            }

            if (number === win.number.replace(/\D/g, "")) {
                conversation = win;
                break;
            }
        }

        return conversation;
    },

    // FIXME modules/mpris.js
    _pauseMedia: function (pause) {
        debug(pause);

        if (pause && this.device._plugins.has("mpris")) {
            let plugin = this.device._plugins.get("mpris");

            for (let player of plugin._players.values()) {
                if (player.PlaybackStatus === "Playing" && player.CanPause) {
                    player.PauseSync();
                    this._pausedPlayer = player;
                }
            }
        }
    },

    // FIXME modules/mpris.js
    _resumeMedia: function () {
        debug("Telephony: _resumeMedia()");

        if (this._pausedPlayer) {
            this._pausedPlayer.PlaySync();
            this._pausedPlayer = false;
        }
    },

    /**
     * Silence an incoming call
     */
    muteCall: function () {
        debug("");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.telephony.request",
            body: { action: "mute" }
        });
        this.send(packet);
    },

    /**
     * Open and present a new SMS window
     */
    openSms: function () {
        debug("Telephony: openSms()");

        let window = new TelephonyWidget.ConversationWindow(this.device);
        window.present();
    },


    // FIXME FIXME
    openUri: function (uri) {
        if (!uri instanceof SmsURI) {
            try {
                uri = new SmsURI(uri);
            } catch (e) {
                debug("Error parsing sms URI: " + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(this.device);

            for (let recipient of uri.recipients) {
                // FIXME
                let contact = this.contacts.query({
                    number: recipient,
                    name: "",
                    single: false
                });
                window.addRecipient(recipient, contact);
            }
            window.urgency_hint = true;
        }

        // Set the outgoing message if the uri has a body variable
        if (uri.body) {
            window.setMessage(uri.body);
        }

        window.present();
    },

    /**
     * Either open a new SMS window for the caller or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {number} time - The event time in epoch us
     */
    replyMissedCall: function (phoneNumber, contactName, time) {
        debug(event);

        // Get a contact
        let contact = this.contacts.getContact(
            phoneNumber,
            contactName
        );

        // Check open windows for this number
        let window = this._hasWindow(phoneNumber);

        // None found; open one, mark duplicate read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(this.device);

            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").markDuplicate({
                    localId: "missedCall|" + time,
                    ticker: _("Missed call") + ": " + contact.name,
                    isCancel: true
                });
            }
        }

        // FIXME: log the missed call in the window
        window.receiveMessage(
            contact,
            phoneNumber,
            "<i>" + _("Missed call at %s").format(time) + "</i>"
        );

        window.present();
    },

    /**
     * Either open a new SMS window for the sender or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} messageBody - The SMS message
     * @param {number} time - The event time in epoch us
     */
    replySms: function (phoneNumber, contactName, messageBody, time) {
        debug(arguments);

        // Check for an extant window
        let window = this._hasWindow(phoneNumber);

        // None found
        if (!window) {
            // Open a new window
            window = new TelephonyWidget.ConversationWindow(this.device);

            let contact = this.contacts.getContact(
                contactName,
                phoneNumber
            );

            // Log the message
            window.receiveMessage(contact, phoneNumber, messageBody);
            window.urgency_hint = true;

            // Tell the notification plugin to mark any duplicate read
            let notification = this.device._plugins.get("notification");
            if (notification) {
                notification.markDuplicate({
                    localId: "sms|" + time,
                    ticker: contact.name + ": " + messageBody,
                    isCancel: true
                });
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
        debug("Telephony: sendSms(" + phoneNumber + ", " + messageBody + ")");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });

        this.send(packet);
    },

    /**
     * Share a link by SMS message
     *
     * @param {string} url - The link to be shared
     */
    // FIXME: re-check
    shareUri: function (url) {
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let hasConversations = false;

        for (let index_ in windows) {
            let window = windows[index_];

            if (window.device && window.device.id === this.device.id) {
                if (window.number) {
                    hasConversations = true;
                    break;
                }
            }
        }

        let window;

        if (hasConversations) {
            window = new TelephonyWidget.ShareWindow(this.device, url);
        } else {
            window = new TelephonyWidget.ConversationWindow(this.device);
            window.setMessage(url);
        }

        window.present();
    }
});


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var SmsURI = new Lang.Class({
    Name: "GSConnectSmsURI",

    _init: function (uri) {
        debug("SmsURI: _init(" + uri + ")");

        let full, recipients, query;

        try {
            _smsRegex.lastIndex = 0;
            [full, recipients, query] = _smsRegex.exec(uri);
        } catch (e) {
            throw URIError("malformed sms URI");
        }

        this.recipients = recipients.split(",").map((recipient) => {
            _numberRegex.lastIndex = 0;
            let [full, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(";")) {
                    let [key, value] = param.split("=");

                    // add phone-context to beginning of
                    if (key === "phone-context" && value.startsWith("+")) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split("&")) {
                let [key, value] = field.split("=");

                if (key === "body") {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    },

    toString: function () {
        let uri = "sms:" + this.recipients.join(",");

        return (this.body) ? uri + "?body=" + escape(this.body) : uri;
    }
});

