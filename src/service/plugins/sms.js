'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const Messaging = imports.service.ui.messaging;
const TelephonyUI = imports.service.ui.telephony;


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
        sms: {
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

            parameter_type: new GLib.VariantType('s'),
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
let _lenientDigits = '[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+';
let _lenientNumber = _lenientDigits + '(?:' + _telParam + ')*';

var _smsRegex = new RegExp(
    '^' +
    'sms:' +                                // scheme
    '(?:[/]{2,3})?' +                       // Gio.File returns ":///"
    '(' +                                   // one or more...
        _lenientNumber +                    // phone numbers
        '(?:,' + _lenientNumber + ')*' +    // separated by commas
    ')' +
    '(?:\\?(' +                             // followed by optional...
        _smsParam +                         // parameters...
        '(?:&' + _smsParam + ')*' +         // separated by "&" (unescaped)
    '))?' +
    '$', 'g');                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    '^' +
    '(' + _lenientDigits + ')' +            // phone number digits
    '((?:' + _telParam + ')*)' +            // followed by optional parameters
    '$', 'g');


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
class URI {
    constructor(uri) {
        _smsRegex.lastIndex = 0;
        let [, recipients, query] = _smsRegex.exec(uri);

        this.recipients = recipients.split(',').map(recipient => {
            _numberRegex.lastIndex = 0;
            let [, number, params] = _numberRegex.exec(recipient);

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
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
var MessageEvent = {
    TEXT_MESSAGE: 0x1
};


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
 * See: https://developer.android.com/reference/android/provider/Telephony.TextBasedSmsColumns.html
 *
 * IN: An incoming message
 * OUT: An outgoing message
 */
var MessageType = {
    ALL: 0,
    INBOX: 1,
    SENT: 2,
    DRAFT: 3,
    OUTBOX: 4,
    FAILED: 5
};


/**
 * SMS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sms
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SMSPlugin/
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
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.conversations = {};
        this.cacheProperties(['conversations']);
    }

    get window() {
        if (this.settings.get_boolean('legacy-sms')) {
            return new TelephonyUI.Dialog({device: this.device});
        }

        if (this._window === undefined) {
            this._window = new Messaging.Window({
                application: this.service,
                device: this.device
            });
        }

        return this._window;
    }

    handlePacket(packet) {
        // Currently only one incoming packet type
        if (packet.type === 'kdeconnect.sms.messages') {
            this._handleMessages(packet.body.messages);
        }
    }

    cacheClear() {
        this.conversations = {};
        this.__cache_write();
        this.notify('conversations');
    }

    cacheLoaded() {
        this.notify('conversations');
    }

    connected() {
        super.connected();
        this.requestConversations();
    }

    /**
     * Handle a new single message
     */
    _handleMessage(contact, message) {
        let conversation = null;

        if (this._window) {
            conversation = this._window.getConversation(message.address);
        }

        if (conversation) {
            // Track expected ticker of outgoing messages so they can be closed
            // FIXME: this is not working well
            if (message.type === MessageType.SENT) {
                conversation._notifications.push(
                    `${contact.name}: ${message.body}`
                );
            }

            conversation.logMessage(message);
        }
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {object[]} messages - A list of sms message objects from a thread
     */
    async _handleConversation(messages) {
        try {
            // If the address is missing this will cause problems...
            if (!messages[0].address) return;

            let thread_id = messages[0].thread_id;
            let conversation = this.conversations[thread_id] || [];
            let contact = this.device.contacts.query({
                number: messages[0].address
            });

            for (let i = 0, len = messages.length; i < len; i++) {
                let message = messages[i];

                // TODO: invalid MessageType
                if (message.type < 0 || message.type > 5) continue;

                let extant = conversation.find(msg => msg._id === message._id);

                if (extant) {
                    Object.assign(extant, message);
                } else {
                    conversation.push(message);
                    await this._handleMessage(contact, message);
                }
            }

            // Sort and store the conversation
            this.conversations[thread_id] = conversation.sort((a, b) => {
                return (a._id < b._id) ? -1 : 1;
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
     * @param {object[]} messages - A list of sms message objects
     */
    async _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0) return;

            let thread_ids = messages.map(msg => msg.thread_id);

            // If there's multiple thread_id's it's a summary of threads
            if (thread_ids.some(id => id !== thread_ids[0])) {

                // Prune conversations
                Object.keys(this.conversations).map(id => {
                    if (!thread_ids.includes(parseInt(id))) {
                        delete this.conversations[id];
                    }
                });

                // Request each new or newer thread
                for (let i = 0, len = messages.length; i < len; i++) {
                    let message = messages[i];
                    let cache = this.conversations[message.thread_id];

                    // If this is for an existing thread, mark the rest as read
                    if (cache && message.read === MessageStatus.READ) {
                        cache.forEach(message => message.read = MessageStatus.READ);
                    }

                    if (!cache || cache[cache.length - 1]._id < message._id) {
                        this.requestConversation(message.thread_id);
                    }
                }

                await this.__cache_write();
                this.notify('conversations');

            // Otherwise this is single thread or new message
            } else {
                await this._handleConversation(messages);
            }
        } catch (e) {
            logError(e);
        }
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
     * @param {string} hint - Could be either a contact name or phone number
     */
    replySms(hint) {
        this.window.present();
        // FIXME: causes problems now that non-numeric addresses are allowed
        //this.window.address = hint.toPhoneNumber();
    }

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms(phoneNumber, messageBody) {
        this.device.sendPacket({
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
     * @param {string} url - The link to be shared
     */
    shareSms(url) {
        // Legacy Mode
        if (this.settings.get_boolean('legacy-sms')) {
            let window = this.window;
            window.present();
            window.setMessage(url);

        // If there are active conversations, show the chooser dialog
        } else if (Object.values(this.conversations).length > 0) {
            let window = new Messaging.ConversationChooser({
                application: this.service,
                device: this.device,
                message: url
            });

            window.present();

        // Otherwise show the window and wait for a contact to be chosen
        } else {
            this.window.present();
            this.window.setMessage(url, true);
        }
    }

    /**
     * Open and present the messaging window
     */
    sms() {
        this.window.present();
    }

    /**
     * This is the sms: URI scheme handler
     * TODO: we should now reject multi-recipient URIs
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new URI(uri);

            let window = this.window;
            window.present();
            window.address = uri.recipients[0];

            // Set the outgoing message if the uri has a body variable
            if (uri.body) {
                window.setMessage(uri.body);
            }
        } catch (e) {
            logError(e, `${this.device.name}: "${uri}"`);
        }
    }

    destroy() {
        if (this._window) {
            this._window.destroy();
        }

        super.destroy();
    }
});

