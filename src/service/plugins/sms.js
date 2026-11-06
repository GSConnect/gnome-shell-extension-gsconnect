// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';
import LegacyMessagingDialog from '../ui/legacyMessaging.js';
import * as Messaging from '../ui/messaging.js';
import SmsURI from '../utils/uri.js';


/**
 * Number of messages requested per page of a thread, as in KDE Connect's
 * smsapp (`MIN_NUMBER_TO_REQUEST`).
 */
const THREAD_PAGE_SIZE = 25;

/**
 * Seconds to wait for a page of a thread before allowing a new request.
 */
const THREAD_PAGE_TIMEOUT = 30;


export const Metadata = {
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
export const MessageEventType = {
    TEXT_MESSAGE: 0x1,
};


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
export const MessageStatus = {
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
export const MessageBox = {
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
const SMSPlugin = GObject.registerClass({
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
}, class SMSPlugin extends Plugin {

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
            return new LegacyMessagingDialog({
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
        this._resetThreadRequests();
        this._requestConversations();
    }

    disconnected() {
        super.disconnected();
        this._resetThreadRequests();
    }

    _resetThreadRequests() {
        if (this._pageRequests !== undefined) {
            for (const request of this._pageRequests.values())
                GLib.source_remove(request.timeoutId);
        }

        // Pending page requests, by thread ID
        this._pageRequests = new Map();

        // Threads whose newest page was fetched on this connection
        this._freshThreads = new Set();

        // Threads known to be loaded back to their first message
        this._completeThreads = new Set();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sms.messages':
                this._handleMessages(packet.body.messages);
                break;
        }
    }

    /**
     * Handle a new single message
     *
     * @param {object} message - A message object
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
     * @param {object[]} thread - A list of sms message objects from a thread
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
     * Handle the messages of a single thread from a `kdeconnect.sms.messages`
     * packet.
     *
     * KDE Connect for Android answers `request_conversations` with one packet
     * per thread, each holding only the thread's latest message. Threads are
     * not fetched here: the messaging window requests them page by page with
     * `requestThreadPage()` when they are viewed.
     *
     * @param {object[]} messages - A list of sms message objects
     */
    _handleSingleThread(messages) {
        const thread_id = messages[0].thread_id;
        const cache = this.threads[thread_id];
        const known = new Set((cache || []).map(m => m.date));

        // If the latest message is marked read, mark the rest as read
        if (cache !== undefined && messages.length === 1 &&
            messages[0].read === MessageStatus.READ) {
            for (const msg of cache)
                msg.read = MessageStatus.READ;
        }

        this._handleThread(messages);

        // Anything arriving for a thread with a pending page request is taken
        // as the response; the protocol has no request IDs to match on
        const request = this._pageRequests?.get(thread_id);

        if (request !== undefined)
            this._handleThreadPage(thread_id, request, messages, known);
    }

    /**
     * Handle a page of messages requested with `requestThreadPage()`.
     *
     * @param {string} thread_id - The thread ID
     * @param {object} request - The pending request
     * @param {object[]} messages - The messages received
     * @param {Set<number>} known - Dates of the messages cached before
     */
    _handleThreadPage(thread_id, request, messages, known) {
        this._pageRequests.delete(thread_id);
        GLib.source_remove(request.timeoutId);

        const oldest = Math.min(...messages.map(m => m.date));
        const added = messages.filter(m => !known.has(m.date));

        // A short page, or one with nothing older than we had, means we've
        // reached the start of the thread
        if (messages.length < THREAD_PAGE_SIZE ||
            (request.older && !added.some(m => m.date < request.start))) {
            this._completeThreads.add(thread_id);
            return;
        }

        // The newest page didn't reach the cached messages, so messages that
        // arrived while disconnected are missing in between: keep going back
        // until the gap is filled
        const cachedBefore = [...known].filter(date => date < oldest);
        const overlaps = messages.some(m => known.has(m.date));

        if (!overlaps && cachedBefore.length > 0)
            this._sendThreadPageRequest(thread_id, oldest);
    }

    /**
     * Request a page of messages for a thread, if one isn't already pending.
     *
     * The first request for a thread on each connection fetches its newest
     * messages; later requests fetch messages older than the oldest cached
     * one, so the full history is only downloaded as it's scrolled through.
     *
     * @param {string} thread_id - The thread ID
     * @returns {boolean} %true if a page is pending, %false if there is nothing
     *   (more) to request
     */
    requestThreadPage(thread_id) {
        if (!this.device.connected || thread_id === null)
            return false;

        if (this._pageRequests === undefined)
            this._resetThreadRequests();

        thread_id = `${thread_id}`;

        if (this._pageRequests.has(thread_id))
            return true;

        if (!this._freshThreads.has(thread_id)) {
            this._freshThreads.add(thread_id);
            this._sendThreadPageRequest(thread_id, -1);
            return true;
        }

        const cache = this.threads[thread_id];

        if (this._completeThreads.has(thread_id) || !cache?.length)
            return false;

        this._sendThreadPageRequest(thread_id, cache[0].date);
        return true;
    }

    /**
     * Send a `request_conversation` packet for a page of a thread.
     *
     * @param {string} thread_id - The thread ID
     * @param {number} start - Fetch messages up to this date (inclusive), or
     *   -1 for the newest messages
     */
    _sendThreadPageRequest(thread_id, start) {
        const request = {
            older: start >= 0,
            start: start,
            timeoutId: GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                THREAD_PAGE_TIMEOUT, () => {
                    this._pageRequests.delete(thread_id);
                    return GLib.SOURCE_REMOVE;
                }),
        };
        this._pageRequests.set(thread_id, request);

        const body = {
            threadID: thread_id,
            numberToRequest: THREAD_PAGE_SIZE,
        };

        if (start >= 0)
            body.rangeStartTimestamp = start;

        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: body,
        });
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {object[]} messages - A list of sms message objects
     */
    _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0)
                return;

            const threads = new Map();

            // Perform some modification of the messages
            for (let i = 0, len = messages.length; i < len; i++) {
                const message = messages[i];

                // COERCION: thread_id's to strings
                message.thread_id = `${message.thread_id}`;

                // TODO: Remove bogus `insert-address-token` entries
                let a = message.addresses.length;

                while (a--) {
                    if (message.addresses[a].address === undefined ||
                        message.addresses[a].address === 'insert-address-token')
                        message.addresses.splice(a, 1);
                }

                if (!threads.has(message.thread_id))
                    threads.set(message.thread_id, []);

                threads.get(message.thread_id).push(message);
            }

            // A packet holding several threads is not a reliable digest: the
            // thread summary now arrives one thread per packet, and a packet
            // of new messages can also carry the previous latest message of
            // another thread. Handle each thread on its own and never prune
            // the cache based on a single packet.
            for (const thread of threads.values())
                this._handleSingleThread(thread);
        } catch (e) {
            debug(e, this.device.name);
        }
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
     * @param {object[]} addresses - A list of address objects
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
            uri = new SmsURI(uri);

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
        for (const taddressObj of thread[0].addresses) {
            if (addressObj.address?.equalsPhoneNumber(taddressObj.address))
                return true;
        }
        return false;
    }

    /**
     * Try to find a thread_id in for {@link addresses}.
     *
     * @param {object[]} addresses - a list of address objects
     * @returns {string|null} a thread ID
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

export default SMSPlugin;
