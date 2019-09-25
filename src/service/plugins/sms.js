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
        sendMessage: {
            label: _('Send Message'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(aa{sv})'),
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
var MessageBox = {
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
        'threads': GObject.param_spec_variant(
            'threads',
            'Conversation List',
            'A list of threads',
            new GLib.VariantType('aa{sv}'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.threads = {};
        this.cacheProperties(['threads']);
        this._version = 1;
    }

    get window() {
        if (this.settings.get_boolean('legacy-sms')) {
            return new TelephonyUI.LegacyMessagingDialog({
                device: this.device,
                plugin: this
            });
        }

        if (this._window === undefined) {
            this._window = new Messaging.Window({
                application: this.service,
                device: this.device,
                plugin: this
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
        this.threads = {};
        this.__cache_write();
        this.notify('threads');
    }

    cacheLoaded() {
        // Backwards compatibility with single-address format
        let threads = Object.values(this.threads);

        if (threads.length > 0 && threads[0][0].address) {
            for (let t = 0, n_threads = threads.length; t < n_threads; t++) {
                let thread = n_threads[t];

                for (let m = 0, n_msgs = thread.length; m < n_msgs; m++) {
                    let message = thread[m];

                    message.addresses = [{address: message.address}];
                    message.thread_id = parseInt(message.thread_id, 10);
                    delete message.address;
                }
            }
        }

        this.notify('threads');
    }

    connected() {
        super.connected();
        this.requestConversations();
    }

    /**
     * Handle a digest of threads.
     *
     * @param {Object[]} messages - A list of message objects
     * @param {string[]} thread_ids - A list of thread IDs as strings
     */
    _handleDigest(messages, thread_ids) {
        // Prune threads
        for (let thread_id of Object.keys(this.threads)) {
            if (!thread_ids.includes(thread_id)) {
                delete this.threads[thread_id];
            }
        }

        // Request each new or newer thread
        for (let i = 0, len = messages.length; i < len; i++) {
            let message = messages[i];
            let cache = this.threads[message.thread_id];

            // If this message is marked read and it's for an existing
            // thread, we should mark the rest in this thread as read
            if (cache && message.read === MessageStatus.READ) {
                cache.forEach(msg => msg.read = MessageStatus.READ);
            }

            // If we don't have a thread for this message or it's newer
            // than the last message in the cache, request the thread
            if (!cache || cache[cache.length - 1].date < message.date) {
                this.requestConversation(message.thread_id);
            }
        }

        this.__cache_write();
        this.notify('threads');
    }

    /**
     * Handle a new single message
     *
     * @param {Object} message - A message object
     */
    _handleMessage(message) {
        let conversation = null;

        // If the window is open, try and find an active conversation
        if (this._window) {
            conversation = this._window.getConversationForMessage(message);
        }

        // If there's an active conversation, we should log the message now
        if (conversation) {
            conversation.logNext(message);
        }
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Object[]} thread - A list of sms message objects from a thread
     */
    _handleThread(thread) {
        try {
            // If there are no addresses this will cause major problems...
            if (!thread[0].addresses || !thread[0].addresses[0]) return;

            let thread_id = thread[0].thread_id;
            let cache = this.threads[thread_id] || [];

            // Handle each message
            for (let i = 0, len = thread.length; i < len; i++) {
                let message = thread[i];

                // TODO: invalid MessageBox
                if (message.type < 0 || message.type > 5) continue;

                // If the message exists, just update it
                let cacheMessage = cache.find(m => m.date === message.date);

                if (cacheMessage) {
                    Object.assign(cacheMessage, message);
                } else {
                    cache.push(message);
                    this._handleMessage(message);
                }
            }

            // Sort the thread by ascending date and write to cache
            this.threads[thread_id] = cache.sort((a, b) => {
                return (a.date < b.date) ? -1 : 1;
            });

            this.__cache_write();
            this.notify('threads');
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {object[]} messages - A list of sms message objects
     */
    _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0) return;

            // TODO: Backwards compatibility kdeconnect-android <= ???
            if (messages[0].address) {
                this._version = 1;

                for (let i = 0, len = messages.length; i < len; i++) {
                    let message = messages[i];

                    message.addresses = [{address: message.address}];
                    message.thread_id = parseInt(message.thread_id, 10);
                    delete message.address;
                }
            } else {
                this._version = 2;
            }

            // If there's multiple thread_id's it's a summary of threads
            // COERCION: thread_id's to strings
            let thread_ids = messages.map(msg => `${msg.thread_id}`);

            if (thread_ids.some(id => id !== thread_ids[0])) {
                this._handleDigest(messages, thread_ids);

            // Otherwise this is single thread or new message
            } else {
                this._handleThread(messages);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Request a list of messages from a single thread.
     *
     * @param {Number} thread_id - The id of the thread to request
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
        this.sendMessage([{address: phoneNumber}], messageBody, 1, true);
    }

    /**
     * Send a message
     *
     * @param {Array of Address} addresses - A list of address objects
     * @param {string} messageBody - The message text
     * @param {number} [event] - An event bitmask
     * @param {boolean} [forceSms] - Whether to force SMS
     * @param {number} [subId] - The SIM card to use
     */
    sendMessage(addresses, messageBody, event = 1, forceSms = false, subId = undefined) {
        // TODO: waiting on support in kdeconnect-android
        // if (this._version === 1) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: addresses[0].address,
                messageBody: messageBody
            }
        });
        // } else if (this._version == 2) {
        //     this.device.sendPacket({
        //         type: 'kdeconnect.sms.request',
        //         body: {
        //             version: 2,
        //             addresses: addresses,
        //             messageBody: messageBody,
        //             forceSms: forceSms,
        //             sub_id: subId
        //         }
        //     });
        // }
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

        // If there are active threads, show the chooser dialog
        } else if (Object.values(this.threads).length > 0) {
            let window = new Messaging.ConversationChooser({
                application: this.service,
                device: this.device,
                message: url,
                plugin: this
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
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new URI(uri);

            // Lookup contacts
            let addresses = uri.recipients.map(number => {
                return {address: number.toPhoneNumber()};
            });
            let contacts = this.device.contacts.lookupAddresses(addresses);

            // Present the window and show the conversation
            let window = this.window;
            window.present();
            window.setContacts(contacts);

            // Set the outgoing message if the uri has a body variable
            if (uri.body) {
                window.setMessage(uri.body);
            }
        } catch (e) {
            logError(e, `${this.device.name}: "${uri}"`);
        }
    }

    addressesIncludesAddress(addresses, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let taddressObj of addresses) {
            let tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    _threadHasAddress(thread, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let taddressObj of thread[0].addresses) {
            let tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Try to find a thread_id in @smsPlugin for @addresses.
     *
     * @param {Array of Object} - a list of address objects
     */
    getThreadIdForAddresses(addresses) {
        let threads = Object.values(this.threads);

        for (let thread of threads) {
            if (addresses.length !== thread[0].addresses.length) continue;

            if (addresses.every(addressObj => this._threadHasAddress(thread, addressObj))) {
                return thread[0].thread_id;
            }
        }

        return null;
    }

    destroy() {
        if (this._window) {
            this._window.destroy();
        }

        super.destroy();
    }
});

