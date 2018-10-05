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
class URI {
    constructor(uri) {
        _smsRegex.lastIndex = 0;
        let [full, recipients, query] = _smsRegex.exec(uri);

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
            new GLib.VariantType('aa{sv}'),
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
        return Object.values(this.conversations).map(conversation => {
            return conversation[conversation.length - 1];
        });
    }

    handlePacket(packet) {
        switch (packet.type) {
            // (Currently) this is always an answer to a request
            case 'kdeconnect.sms.messages':
                this._handleMessages(packet);
                break;

            default:
                logError('Unknown telephony packet', this.device.name);
        }
    }

    cacheLoaded() {
        this.notify('conversations');
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
            let isConversation = window.hasOwnProperty('_populateConversations');

            if (isConversation && window.device === this.device) {
                window._populateConversations();
            }
        }
    }

    /**
     * Handle a new single message
     */
    _handleMessage(contact, message) {
        // Silence the duplicate as soon as possible
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            notification.trackDuplicate(
                `${contact.name}: ${message.body}`,
                contact.name,
                message.address
            );
        }

        // Check for an extant window
        let window = this._hasWindow(message.address);

        if (window) {
            // Track the notification so the window can close it when focused
            window._notifications.push(`${contact.name}: ${message.body}`);

            if (this.device.get_outgoing_supported('sms.messages')) {
                window._populateMessages(message.thread_id);
            } else {
                window.receiveMessage(contact, message);
                window.urgency_hint = true;
            }
        }
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Array} messages - A list of telephony message objects
     */
    async _handleConversation(messages) {
        try {
            if (messages.length === 0) {
                return;
            }

            let contact = this.contacts.query({
                number: messages[0].address,
                create: true
            });

            let thread_id = messages[0].thread_id;
            let thread = this.conversations[thread_id] || [];

            for (let message of messages) {
                let message_id = message._id;

                if (thread.every(msg => msg._id !== message_id)) {
                    thread.push(message);
                    this._handleMessage(contact, message);
                }
            }

            this.conversations[thread_id] = thread.sort((a, b) => {
                return (a.date < b.date) ? -1 : 1;
            });

            await this.__cache_write();
            this.notify('conversations');
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {kdeconnect.sms.messages} packet - An incoming packet
     */
    async _handleMessages(packet) {
        try {
            // If messages is empty there's nothing to do...
            if (packet.body.messages.length === 0) {
                return;
            }

            let thread_ids = packet.body.messages.map(msg => msg.thread_id);

            // If there's multiple thread_id's it's a summary of threads
            if (thread_ids.some(id => id !== thread_ids[0])) {

                // Prune conversations
                Object.keys(this.conversations).map(id => {
                    if (!thread_ids.includes(id)) {
                        delete this.conversations[id];
                    }
                });
                await this.__cache_write();

                // Request each thread
                thread_ids.map(id => this.requestConversation(id));

                // We call this instead of notify::threads so the conversation
                // windows don't have to deal with the plugin loading/unloading.
                this._updateConversations();

            // Otherwise this is single thread or new message
            } else {
                this._handleConversation(packet.body.messages);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Check if there's an open conversation for a number
     *
     * @param {String} number - A string phone number
     */
    _hasWindow(address) {
        debug(address);

        // Look for an open window with this phone number
        let number = address.replace(/\D/g, '').replace(/^[0]?/, '');

        for (let win of this.service.get_windows()) {
            if (!win.device || win.device.id !== this.device.id || !win.number) {
                continue;
            }

            let wnumber = win.number.replace(/\D/g, '').replace(/^[0]?/, '');

            if (number.endsWith(wnumber) || wnumber.endsWith(number)) {
                return win;
            }
        }

        return false;
    }

    /**
     * Request a list of messages from a single thread.
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
     * Request a list of the last message in each unarchived thread.
     */
    requestConversations() {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations'
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
        // Ensure we have a contact
        let contact = this.contacts.query({ number: message.address });

        // Check for an extant window
        let window = this._hasWindow(message.address);

        // Open a new window if not
        if (!window) {
            window = new Messaging.ConversationWindow(this.device);
            window.urgency_hint = true;

            // Set the recipient if messages are supported
            if (this.device.get_outgoing_supported('sms.messages')) {
                window.setRecipient(contact, message.address);

            // Otherwise log the fabricated message object
            } else {
                window.receiveMessage(contact, message);
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
     * This is the sms: URI scheme handler
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new URI(uri);

            // FIXME: need batch SMS window now
            for (let recipient of uri.recipients) {
                // Check for an extant window
                let window = this._hasWindow(uri.recipients[0]);

                // None found; open one and add the contact
                if (!window) {
                    window = new Messaging.ConversationWindow(this.device);

                    let contact = this.contacts.query({
                        number: recipient
                    });
                    window.setRecipient(contact, recipient);
                    window.urgency_hint = true;
                }

                // Set the outgoing message if the uri has a body variable
                if (uri.body) {
                    window.setMessage(uri.body);
                }

                window.present();
            }
        } catch (e) {
            logError(e, `${this.device.name}: "${uri}"`);
        }
    }
});

