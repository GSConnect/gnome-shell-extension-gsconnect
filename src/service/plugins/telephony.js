"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Contacts = imports.modules.contacts;
const Sms = imports.modules.sms;
const Sound = imports.modules.sound;
const PluginsBase = imports.service.plugins.base;


var Allow = {
    NONE: 1,
    OUT: 2,
    IN: 4,
    CALLS: 8,
    SMS: 16
};


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    incomingCapabilities: ["kdeconnect.telephony"],
    outgoingCapabilities: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    actions: {
        // Call Actions
        muteCall: {
            summary: _("Mute Call"),
            description: _("Silence an incoming call"),
            icon_name: "audio-volume-muted-symbolic",

            signature: null,
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.telephony.request"],
            allow: Allow.OUT | Allow.IN | Allow.CALLS
        },

        // SMS Actions
        newSms: {
            summary: _("New SMS"),
            description: _("Start a new SMS conversation"),
            icon_name: "sms-symbolic",

            signature: null,
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: Allow.OUT | Allow.IN | Allow.SMS
        },
        replySms: {
            summary: _("Reply SMS"),
            description: _("Reply to an SMS message"),
            icon_name: "sms-symbolic",

            signature: "v",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: Allow.OUT | Allow.IN | Allow.SMS
        },
        sendSms: {
            summary: _("Send SMS"),
            description: _("Send an SMS message"),
            icon_name: "sms-send",

            signature: "(ss)",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: Allow.OUT | Allow.IN | Allow.SMS
        },
        callNotification: {
            summary: _("Call Notification"),
            description: _("Show a notification tailored for phone calls"),
            icon_name: "sms-symbolic",

            signature: "v",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: Allow.OUT | Allow.IN | Allow.CALLS | Allow.SMS
        },
        smsNotification: {
            summary: _("SMS Notification"),
            description: _("Show a notification that opens a new conversation when activated"),
            icon_name: "sms-symbolic",

            signature: "a{sv}",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: Allow.OUT | Allow.IN | Allow.SMS
        }
    },
    events: {
        // SMS Events
        missedCall: {
            summary: _("Missed Call"),
            description: _("An incoming call was missed"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        ringing: {
            summary: _("Incoming Call"),
            description: _("An incoming call"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        sms: {
            summary: _("SMS Message"),
            description: _("An incoming SMS message"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        talking: {
            summary: _("Call In Progress"),
            description: _("An incoming call was answered"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        // FIXME: isCancel???
        ended: {
            summary: _("Call Ended"),
            description: _("An incoming call ended"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        }
    }
};


var MediaState = {
    NONE: 1,
    VOLUME_LOWERED: 2,
    VOLUME_MUTED: 4,
    MICROPHONE_MUTED: 8,
    MEDIA_PAUSED: 16
};


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
var Plugin = GObject.registerClass({
    GTypeName: "GSConnectTelephonyPlugin",
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, "telephony");

        this.contacts = Contacts.getStore();

    }

    handlePacket(packet) {
        debug(packet);

        let event = this._parsePacket(packet);

        // Event handling
        // The event has ended (ringing stopped or call ended)
        if (packet.body.isCancel) {
            // TODO TODO TODO: all of it
            this._setMediaState(1);
            this.device.withdraw_notification(
                event.type + "|" + event.contact.name
            );
        // An event was triggered
        } else {
            this.event(event.type, event);

            if (event.type === "sms" && (this.allow & Allow.SMS)) {
                this._onSms(event);
            } else if (this.allow & Allow.CALLS) {
                switch (event.type) {
                    case "missedCall":
                        this._onMissedCall(event);
                        break;
                    case "ringing":
                        this._onRinging(event);
                        break;
                    case "talking":
                        this._onTalking(event);
                        break;
                    default:
                        log("Unknown telephony event");
                }
            }
        }
    }

    /**
     * Parse an telephony packet and return an event object, with ... TODO
     *
     * @param {Object} packet - A telephony event packet
     * @return {Object} - An event object
     */
    _parsePacket(packet) {
        let event = {
            type: packet.body.event,
            contact: this.contacts.getContact(
                packet.body.contactName,
                packet.body.phoneNumber
            ),
            number: packet.body.phoneNumber,
            time: GLib.DateTime.new_now_local().to_unix()
        };

        // Update contact avatar
        if (packet.body.phoneThumbnail && !event.contact.avatar) {
            debug("updating avatar for " + event.contact.name);

            event.contact.avatar = GLib.build_filenamev([
                Contacts.CACHE_DIR,
                GLib.uuid_string_random() + ".jpeg"
            ]);
            GLib.file_set_contents(
                event.contact.avatar,
                GLib.base64_decode(packet.body.phoneThumbnail)
            );
            this.contacts._writeCache();
        }

        if (event.type === "sms") {
            event.content = packet.body.messageBody;
        } else if (event.type === "missedCall") {
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            event.content = _("Missed call at %s").format(event.time);
        } else if (event.type === "ringing") {
            // TRANSLATORS: eg. Incoming call from John Smith
            event.content = _("Incoming call from %s").format(event.contact.name);
        } else if (event.type === "talking") {
            // TRANSLATORS: eg. Call in progress with John Smith
            event.content = _("Call in progress with %s").format(event.contact.name);
        }

        return event;
    }

    /**
     * Show a local notification that opens a new SMS window when activated
     *
     * @param {Object} event - The telephony event
     * @param {string} event.contact - A contact object for the event
     * @param {string} event.content - The content of the event (message|event description)
     * @param {string} event.number - The phone number reported by KDE Connect
     * @param {number} event.time - The event time in epoch us
     * @param {string} event.type - The event type (sms|missedCall|ringing|talking)
     */
    callNotification(event) {
        let buttons, icon;
        let priority = Gio.NotificationPriority.NORMAL;

        if (event.contact && event.contact.avatar) {
            icon = Contacts.getPixbuf(event.contact.avatar);
        }

        if (event.type === "missedCall") {
            buttons = [{
                action: "replySms",
                // TRANSLATORS: Reply to a missed call by SMS
                label: _("Message"),
                params: event
            }];
            icon = icon || new Gio.ThemedIcon({ name: "call-missed-symbolic" });
        } else if (event.type === "ringing") {
            buttons = [{
                action: "muteCall",
                // TRANSLATORS: Silence an incoming call
                label: _("Mute"),
                params: event
            }];
            icon = icon || new Gio.ThemedIcon({ name: "call-start-symbolic" });
            priority = Gio.NotificationPriority.URGENT;
        } else if (event.type === "talking") {
            icon = icon || new Gio.ThemedIcon({ name: "call-start-symbolic" });
        }

        this.device.showNotification({
            id: event.type + "|" + event.time,
            title: event.contact.name,
            body: event.content,
            icon: icon,
            priority: priority,
            buttons: (buttons) ? buttons : []
        });
    }

    /**
     * Show a local notification that opens a new SMS window when activated
     *
     * @param {Object} event - The telephony event
     * @param {string} event.contact - A contact object for the event
     * @param {string} event.content - The content of the event (message|event description)
     * @param {string} event.number - The phone number reported by KDE Connect
     * @param {number} event.time - The event time in epoch us
     * @param {string} event.type - The event type (sms|missedCall|ringing|talking)
     */
    smsNotification(event) {
        let icon;

        if (event.contact.avatar) {
            icon = Contacts.getPixbuf(event.contact.avatar);
        } else {
            icon = new Gio.ThemedIcon({ name: "sms-symbolic" });
        }

        this.device.showNotification({
            id: event.type + "|"  + event.time,
            title: event.contact.name,
            body: event.content,
            icon: icon,
            priority: Gio.NotificationPriority.HIGH,
            action: {
                name: "replySms",
                params: event
            }
        });
    }

    /**
     * Telephony event handlers
     */
    _onMissedCall(event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get("notification");

        if (notification) {
            // TRANSLATORS: This is specifically for matching missed call notifications on Android.
            // You should translate this to match the notification on your phone that in english looks like "Missed call: John Lennon"
            notification.markDuplicate({
                localId: event.type + "|" + event.time,
                ticker: _("Missed call") + ": " + event.contact.name,
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.number);

        if (window) {
            // FIXME: logging the missed call in the window
            // TODO: need message object
            window.receiveMessage(
                event.contact,
                event.number,
                `<i>${event.content}</i>`
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.type,
                event.contact.name + ": " + event.content
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: event.type + "|" + event.time,
                    ticker: event.contact.name + ": " + event.content,
                    isCancel: true
                });
            }
        }

        this._telephonyAction(event);
    }

    _onRinging(event) {
        debug(event);

        this._telephonyAction(event);
        this._setMediaState(2); // TODO
    }

    _onSms(event) {
        debug(event);

        // Start tracking the duplicate as soon as possible
        let notification = this.device._plugins.get("notification");

        if (notification) {
            notification.markDuplicate({
                localId: event.type + "|" + event.time,
                ticker: event.contact.name + ": " + event.content
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.number);

        if (window) {
            window.receiveMessage(
                event.contact,
                event.number,
                event.content
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.type,
                event.contact.name + ": " + event.content
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: event.type + "|" + event.time,
                    ticker: event.contact.name + ": " + event.content,
                    isCancel: true
                });
            }
        }

        this._telephonyAction(event);
    }

    _onTalking(event) {
        debug(event);

        // TODO: need this, or done by isCancel?
        this.device.withdraw_notification("ringing|" + event.contact.name);

        this._telephonyAction(event);
        this._setMediaState(2); // TODO
    }

    _telephonyAction(event) {
        let actions = gsconnect.full_unpack(
            this.settings.get_value("events")
        )[event.type];

        for (let name in actions) {
            if (actions[name]) {
                let action = this.device.lookup_action(name);

                if (action && action.parameter_type) {
                    action.activate(gsconnect.full_pack(event));
                } else if (action) {
                    action.activate();
                }
            }
        }
    }

    /**
     * Check if there's an open conversation for a number(s)
     *
     * @param {string|array} phoneNumber - A string phone number or array of
     */
    _hasWindow(number) {
        debug(number);

        number = number.replace(/\D/g, "");

        // Get the current open windows
        let windows = this.device.service.get_windows();
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
    }

    // FIXME FIXME FIXME
    _setMediaState(state) {
        if (state === 1) {
            // TODO: restore state here
            this._state = 1;
        } else {
            // TODO: set state here base on flags
            this._state = 2;

            if (state & 2) {
                this._state &= state;
            } else if (state & 4) {
                this._state &= state;
            }
        }
    }

    /**
     * Silence an incoming call
     */
    muteCall() {
        debug("");

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.telephony.request",
            body: { action: "mute" }
        });
    }

    /**
     * Open and present a new SMS window
     */
    newSms() {
        debug("");

        let window = new Sms.ConversationWindow(this.device);
        window.present();
    }

    // FIXME FIXME
    openUri(uri) {
        debug("");

        if (!uri instanceof Sms.URI) {
            try {
                uri = new Sms.URI(uri);
            } catch (e) {
                debug("Error parsing sms URI: " + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new Sms.ConversationWindow(this.device);

            // FIXME: need batch SMS window now
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
    }

    /**
     * Either open a new SMS window for the sender and log the message, which
     * could be a missed call, or reuse an existing one
     *
     * @param {Object} event - The event
     * @param {Object} event.contact - A contact object for the sender
     * @param {string} event.number - The sender's phone number
     * @param {string} event.content - The content of the event (eg. SMS)
     * @param {number} event.time - The event time in epoch us
     */
    replySms(event) {
        debug(event);

        // Check for an extant window
        let window = this._hasWindow(event.number);

        // None found
        if (!window) {
            // Open a new window
            window = new Sms.ConversationWindow(this.device);

            // Log the message
            if (event.content) {
                window.receiveMessage(
                    event.contact,
                    event.number,
                    event.content
                );
                window.urgency_hint = true;
            }

            // Tell the notification plugin to mark any duplicate read
            let notification = this.device._plugins.get("notification");

            if (notification) {
                notification.markDuplicate({
                    localId: event.type + "|" + event.time,
                    ticker: event.contact.name + ": " + event.content,
                    isCancel: true
                });
            }
        }

        window.present();
    }

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms(phoneNumber, messageBody) {
        debug(phoneNumber + ", " + messageBody);

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });
    }

    /**
     * Share a link by SMS message
     *
     * @param {string} url - The link to be shared
     */
    // FIXME: re-check
    shareUri(url) {
        // Get the current open windows
        let windows = this.device.service.get_windows();
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
            window = new Sms.ShareWindow(this.device, url);
        } else {
            window = new Sms.ConversationWindow(this.device);
            window.setMessage(url);
        }

        window.present();
    }
});

