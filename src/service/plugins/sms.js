'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const Messaging = imports.service.ui.messaging;


var Metadata = {
    label: _('SMS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SMS',
    incomingCapabilities: [
        'kdeconnect.sms.messages'
    ],
    outgoingCapabilities: [
        'kdeconnect.sms.request',
        'kdeconnect.sms.request_conversation',
        'kdeconnect.sms.request_conversations'
    ],
    actions: {
        // SMS Actions
        newSms: {
            label: _('Messaging'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        uriSms: {
            label: _('New SMS (URI)'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        }
    }
};


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces.
 * This allows passing numbers directly from libfolks or GData without
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
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var URI = class URI {
    constructor(uri) {
        debug('Sms.URI: _init(' + uri + ')');

        let full, recipients, query;

        try {
            _smsRegex.lastIndex = 0;
            [full, recipients, query] = _smsRegex.exec(uri);
        } catch (e) {
            throw URIError('malformed sms URI');
        }

        this.recipients = recipients.split(',').map(recipient => {
            _numberRegex.lastIndex = 0;
            let [full, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(';')) {
                    let [key, value] = param.split('=');

                    // add phone-context to beginning of
                    if (key === 'phone-context' && value.startsWith('+')) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split('&')) {
                let [key, value] = field.split('=');

                if (key === 'body') {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    }

    toString() {
        let uri = 'sms:' + this.recipients.join(',');

        return (this.body) ? uri + '?body=' + escape(this.body) : uri;
    }
}


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
var MessageStatus = {
    UNREAD: 0,
    READ: 1
};


/**
 * SMS Message direction. IN/OUT match the 'type' field from the Android App
 * message packet.
 *
 * NOTICE: A general message (eg. timestamp, missed call)
 * IN: An incoming message
 * OUT: An outgoing message
 */
var MessageType = {
    NOTICE: 0,
    IN: 1,
    OUT: 2
};


/**
 * SMS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/TelephonyPlugin
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSMSPlugin',
    Properties: {
        'conversations': GObject.param_spec_variant(
            'conversations',
            'Conversation List',
            'A list of conversations',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'threads': GObject.param_spec_variant(
            'threads',
            'Thread List',
            'A list of active (unarchived) conversations',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.contacts = this.service.contacts;

        // We cache converations/threads so they can be used immediately, even
        // though we'll request them at every connection
        this.conversations = {};
        this.cacheProperties(['conversations']);
    }

    get threads() {
        let threads = [];

        for (let conversation of Object.values(this.conversations)) {
            threads.push(conversation[conversation.length - 1]);
        }

        return threads;
    }

    handlePacket(packet) {
        switch (packet.type) {
            // (Currently) this is always an answer to a request
            case 'kdeconnect.sms.messages':
                this._handleMessage(packet);
                break;

            default:
                logError('Unknown telephony packet', this.device.name);
        }
    }

    connected() {
        super.connected();

        this.requestConversations();
    }

    /**
     * Update the conversations in any open windows for this device.
     */
    _updateConversations() {
        for (let window of this.service.get_windows()) {
            let isConversation = (window instanceof Messaging.ConversationWindow);

            if (isConversation && window.device === this.device) {
                window._populateConversations();
            }
        }
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Array} messages - A list of telephony message objects
     */
    _handleConversation(messages) {
        let number = messages[0].address;

        // HACK: If we sent to a *slightly* different number than what KDE
        // Connect uses, we check each message until we find one.
        for (let message of messages) {
            let contact = this.contacts.query({
                number: message.address,
                single: true
            });

            if (contact && contact.origin !== 'gsconnect') {
                number = message.address;
                break;
            }
        }

        // TODO: messaging.js could just do this on demand, but this way it
        // happens in a Promise and we know the last is the most recent...
        this.conversations[number] = messages.sort((a, b) => {
            return (a.date < b.date) ? -1 : 1;
        });

        // Update any open windows...
        let window = this._hasWindow(number);

        if (window) {
            window._populateMessages(number);
        }

        this.notify('conversations');

        return messages[messages.length - 1];
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {kdeconnect.sms.messages} packet - An incoming packet
     */
    _handleMessage(packet) {
        // If messages is empty there's nothing to do...
        if (packet.body.messages.length < 1) {
            return;
        }

        let thread_id = packet.body.messages[0].thread_id;

        // If there are differing thread_id's then this is a list of threads
        if (packet.body.messages.some(msg => msg.thread_id !== thread_id)) {
            let threads = packet.body.messages;

            // Request each thread
            for (let message of threads) {
                this.requestConversation(message.thread_id);
            }

            // Prune conversations
            // TODO: this might always prune because of the HACK in
            // _handleConversation()
            // FIXME: 'address' undefined
            let numbers = threads.map(t => t.address);

            for (let number in this.conversations) {
                if (!numbers.includes(number)) {
                    delete this.conversations[number];
                }
            }

            // We call this instead of notify::threads so the conversation
            // windows don't have to deal with the plugin loading/unloading.
            this._updateConversations();

        // Otherwise this is a single thread
        } else {
            this._handleConversation(packet.body.messages);
        }
    }

    /**
     * Check if there's an open conversation for a number
     *
     * @param {String} number - A string phone number
     */
    _hasWindow(number) {
        debug(number);

        number = number.replace(/\D/g, '');

        // Look for an open window with this contact
        for (let win of this.service.get_windows()) {
            if (!win.device || win.device.id !== this.device.id) {
                continue;
            }

            if (win.number !== null && number === win.number.replace(/\D/g, '')) {
                return win;
            }
        }

        return false;
    }

    /**
     * Request a conversation, which is a list of messages from a single thread.
     *
     * @param {Number} thread_id - The thread_id of the conversation to request
     */
    requestConversation(thread_id) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id
            }
        });
    }

    /**
     * Request a list of conversations, which is a list of the last message in
     * each unarchived thread.
     */
    requestConversations() {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations'
        });
    }

    _onSms(contact, message) {
        // Silence the duplicate as soon as possible
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            notification.silenceDuplicate(`${contact.name}: ${message.body}`);
        }

        // Try to update the conversation in time to open the window
        if (this.conversations.hasOwnProperty(message.address)) {
            this.requestConversation(
                this.conversations[message.address][0].thread_id
            );
        } else {
            this.requestConversations();
        }

        // Check for an extant window
        let window = this._hasWindow(message.address);

        if (window) {
            // We log the message even though the thread might be updated later
            window.receiveMessage(contact, message);
            window.urgency_hint = true;

            // Track the smsNotification so the window can close it when focused
            window._notifications.push(`${contact.name}: ${message.body}`);

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.closeDuplicate(`${contact.name}: ${message.body}`);
            }
        }

        // Always show a notification
        this.smsNotification(contact, message);
    }

    /**
     * Show a local notification that calls replySms(@message) when activated.
     *
     * @param {Object} contact - A contact object
     * @param {Object} message - A telephony message object
     */
    smsNotification(contact, message) {
        let icon;

        if (contact.avatar) {
            icon = this.service.contacts.getPixbuf(contact.avatar);
        }

        if (icon === undefined) {
            icon = new Gio.ThemedIcon({ name: 'sms-symbolic' });
        }

        this.device.showNotification({
            // Use the notification ticker style for the id
            id: `${contact.name}: ${message.body}`,
            title: contact.name,
            body: message.body,
            icon: icon,
            priority: Gio.NotificationPriority.HIGH,
            action: {
                name: 'replySms',
                parameter: GLib.Variant.full_pack(message)
            }
        });
    }

    /**
     * A notification action for replying to SMS messages (or missed calls).
     *
     * TODO: If kdeconnect.sms.message packet is not supported, @message was
     * populated by Telephony._parseEvent() and we log it in the window. If it
     * is supported, the thread should be up to date and only the recipient will
     * be set. Do neither if a window is already open for this thread.
     *
     * @param {Object} message - A telephony message object
     */
    replySms(message) {
        // Check for an extant window
        let window = this._hasWindow(message.address);

        // Open a new window if not
        if (!window) {
            window = new Messaging.ConversationWindow(this.device);
            window.urgency_hint = true;

            // Ensure we have a contact
            let contact = this.contacts.query({
                name: message.contactName,
                number: message.address,
                single: true,
                create: true
            });

            // Set the recipient if it's a missed call or messages are supported
            let msgs = this.device.get_outgoing_supported('telephony.sms.messages');

            if (msgs || message.event === 'missedCall') {
                window.setRecipient(contact, message.address);
            // Otherwise log the fabricated message object
            } else {
                window.receiveMessage(contact, message);
            }
        }

        // Tell the notification plugin to mark any duplicate read
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            notification.closeDuplicate(`${message.contactName}: ${message.body}`);
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
        debug(phoneNumber + ', ' + messageBody);

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });
    }

    /**
     * Share a text content by SMS message. This is used by the WebExtension to
     * share URLs from the browser, but could be used to initiate sharing of any
     * text content.
     *
     * TODO: integrate new telephony.message functionality
     *
     * @param {string} url - The link to be shared
     */
    shareSms(url) {
        // Get the current open windows
        let windows = this.service.get_windows();
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

        // Show an intermediate dialog to allow choosing from open conversations
        if (hasConversations) {
            window = new Messaging.ConversationChooser(this.device, url);

        // Open the list of contacts to start a new conversation
        } else {
            window = new Messaging.ConversationWindow(this.device);
            window.setMessage(url);
        }

        window.present();
    }

    /**
     * Open and present a new SMS window
     */
    newSms() {
        let window = new Messaging.ConversationWindow(this.device);
        window.present();
    }

    /**
     * This is the sms: URI scheme handler.
     * TODO: very likely broken right now
     */
    uriSms(uri) {
        debug(uri);

        if (!uri instanceof URI) {
            try {
                uri = new URI(uri);
            } catch (e) {
                debug('Error parsing sms URI: ' + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients[0]);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new Messaging.ConversationWindow(this.device);

            // FIXME: need batch SMS window now
            for (let recipient of uri.recipients) {
                // FIXME
                let contact = this.contacts.query({
                    number: recipient,
                    name: '',
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
});

