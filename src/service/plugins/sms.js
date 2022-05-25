'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginBase = imports.service.plugin;
const LegacyMessaging = imports.service.ui.legacyMessaging;
const Messaging = imports.service.ui.messaging;
const URI = imports.service.utils.uri;


var Metadata = {
    label: _('SMS'),
    description: _('Send and read SMS of the paired device and be notified of new SMS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SMS',
    incomingCapabilities: [
        'kdeconnect.sms.messages',
    ],
    outgoingCapabilities: [
        'kdeconnect.sms.request',
        'kdeconnect.sms.request_conversation',
        'kdeconnect.sms.request_conversations',
    ],
    actions: {
        // SMS Actions
        sms: {
            label: _('Messaging'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        uriSms: {
            label: _('New SMS (URI)'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendMessage: {
            label: _('Send Message'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(aa{sv})'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
    },
};


/**
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
var MessageEvent = {
    TEXT_MESSAGE: 0x1,
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
    READ: 1,
};


/**
 * SMS Message type, set from the 'type' field in the Android App
 * message packet.
 *
 * See: https://developer.android.com/reference/android/provider/Telephony.TextBasedSmsColumns.html
 *
 * ALL: all messages
 * INBOX: Received messages
 * SENT: Sent messages
 * DRAFT: Message drafts
 * OUTBOX: Outgoing messages
 * FAILED: Failed outgoing messages
 * QUEUED: Messages queued to send later
 */
var MessageBox = {
    ALL: 0,
    INBOX: 1,
    SENT: 2,
    DRAFT: 3,
    OUTBOX: 4,
    FAILED: 5,
    QUEUED: 6,
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
        ),
    },
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.cacheProperties(['_threads']);
    }

    get threads() {
        if (this._threads === undefined)
            this._threads = {};

        return this._threads;
    }

    get window() {
        if (this.settings.get_boolean('legacy-sms')) {
            return new LegacyMessaging.Dialog({
                device: this.device,
                plugin: this,
            });
        }

        if (this._window === undefined) {
            this._window = new Messaging.Window({
                application: Gio.Application.get_default(),
                device: this.device,
                plugin: this,
            });

            this._window.connect('destroy', () => {
                this._window = undefined;
            });
        }

        return this._window;
    }

    clearCache() {
        this._threads = {};
        this.notify('threads');
    }

    cacheLoaded() {
        this.notify('threads');
    }

    connected() {
        super.connected();
        this._requestConversations();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sms.messages':
                this._handleMessages(packet.body.messages);
                break;
        }
    }

    /**
     * Handle a digest of threads.
     *
     * @param {Object[]} messages - A list of message objects
     * @param {string[]} thread_ids - A list of thread IDs as strings
     */
    _handleDigest(messages, thread_ids) {
        // Prune threads
        for (const thread_id of Object.keys(this.threads)) {
            if (!thread_ids.includes(thread_id))
                delete this.threads[thread_id];
        }

        // Request each new or newer thread
        for (let i = 0, len = messages.length; i < len; i++) {
            const message = messages[i];
            const cache = this.threads[message.thread_id];

            if (cache === undefined) {
                this._requestConversation(message.thread_id);
                continue;
            }

            // If this message is marked read, mark the rest as read
            if (message.read === MessageStatus.READ) {
                for (const msg of cache)
                    msg.read = MessageStatus.READ;
            }

            // If we don't have a thread for this message or it's newer
            // than the last message in the cache, request the thread
            if (!cache.length || cache[cache.length - 1].date < message.date)
                this._requestConversation(message.thread_id);
        }

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
        if (this._window)
            conversation = this._window.getConversationForMessage(message);

        // If there's an active conversation, we should log the message now
        if (conversation)
            conversation.logNext(message);
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Object[]} thread - A list of sms message objects from a thread
     */
    _handleThread(thread) {
        // If there are no addresses this will cause major problems...
        if (!thread[0].addresses || !thread[0].addresses[0])
            return;

        const thread_id = thread[0].thread_id;
        const cache = this.threads[thread_id] || [];

        // Handle each message
        for (let i = 0, len = thread.length; i < len; i++) {
            const message = thread[i];

            // TODO: We only cache messages of a known MessageBox since we
            // have no reliable way to determine its direction, let alone
            // what to do with it.
            if (message.type < 0 || message.type > 6)
                continue;

            // If the message exists, just update it
            const cacheMessage = cache.find(m => m.date === message.date);

            if (cacheMessage) {
                Object.assign(cacheMessage, message);
            } else {
                cache.push(message);
                this._handleMessage(message);
            }
        }

        // Sort the thread by ascending date and notify
        this.threads[thread_id] = cache.sort((a, b) => a.date - b.date);
        this.notify('threads');
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {Object[]} messages - A list of sms message objects
     */
    _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0)
                return;

            const thread_ids = [];

            // Perform some modification of the messages
            for (let i = 0, len = messages.length; i < len; i++) {
                const message = messages[i];

                // COERCION: thread_id's to strings
                message.thread_id = `${message.thread_id}`;
                thread_ids.push(message.thread_id);

                // TODO: Remove bogus `insert-address-token` entries
                let a = message.addresses.length;

                while (a--) {
                    if (message.addresses[a].address === undefined ||
                        message.addresses[a].address === 'insert-address-token')
                        message.addresses.splice(a, 1);
                }
            }

            // If there's multiple thread_id's it's a summary of threads
            if (thread_ids.some(id => id !== thread_ids[0]))
                this._handleDigest(messages, thread_ids);

            // Otherwise this is single thread or new message
            else
                this._handleThread(messages);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Request a list of messages from a single thread.
     *
     * @param {number} thread_id - The id of the thread to request
     */
    _requestConversation(thread_id) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id,
            },
        });
    }

    /**
     * Request a list of the last message in each unarchived thread.
     */
    _requestConversations() {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations',
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
        // this.window.address = hint.toPhoneNumber();
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
                messageBody: messageBody,
            },
        });
    }

    /**
     * Send a message
     *
     * @param {Object[]} addresses - A list of address objects
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
                messageBody: messageBody,
            },
        });
        // } else if (this._version === 2) {
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
            const window = this.window;
            window.present();
            window.setMessage(url);

        // If there are active threads, show the chooser dialog
        } else if (Object.values(this.threads).length > 0) {
            const window = new Messaging.ConversationChooser({
                application: Gio.Application.get_default(),
                device: this.device,
                message: url,
                plugin: this,
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
            uri = new URI.SmsURI(uri);

            // Lookup contacts
            const addresses = uri.recipients.map(number => {
                return {address: number.toPhoneNumber()};
            });
            const contacts = this.device.contacts.lookupAddresses(addresses);

            // Present the window and show the conversation
            const window = this.window;
            window.present();
            window.setContacts(contacts);

            // Set the outgoing message if the uri has a body variable
            if (uri.body)
                window.setMessage(uri.body);
        } catch (e) {
            debug(e, `${this.device.name}: "${uri}"`);
        }
    }

    _threadHasAddress(thread, addressObj) {
        const number = addressObj.address.toPhoneNumber();

        for (const taddressObj of thread[0].addresses) {
            const tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number))
                return true;
        }

        return false;
    }

    /**
     * Try to find a thread_id in @smsPlugin for @addresses.
     *
     * @param {Object[]} addresses - a list of address objects
     * @return {string|null} a thread ID
     */
    getThreadIdForAddresses(addresses = []) {
        const threads = Object.values(this.threads);

        for (const thread of threads) {
            if (addresses.length !== thread[0].addresses.length)
                continue;

            if (addresses.every(addressObj => this._threadHasAddress(thread, addressObj)))
                return thread[0].thread_id;
        }

        return null;
    }

    destroy() {
        if (this._window !== undefined)
            this._window.destroy();

        super.destroy();
    }
});
