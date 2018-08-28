'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Contacts = imports.service.components.contacts;
const Sms = imports.service.ui.sms;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony',
    incomingCapabilities: [
        'kdeconnect.telephony',
        'kdeconnect.telephony.message'
    ],
    outgoingCapabilities: [
        'kdeconnect.telephony.request',
        'kdeconnect.telephony.request_conversation',
        'kdeconnect.telephony.request_conversations',
        'kdeconnect.sms.request'
    ],
    actions: {
        // Call Actions
        muteCall: {
            label: _('Mute Call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request']
        },

        // SMS Actions
        newSms: {
            label: _('Open SMS Window'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        }
    }
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/TelephonyPlugin
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyPlugin',
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
        super._init(device, 'telephony');

        this.contacts = Contacts.getStore();

        // We cache converations/threads so they can be used immediately, even
        // though we'll request them at every connection
        this._conversations = {};
        this.cacheProperties(['_conversations']);
    }

    get conversations() {
        return this._conversations;
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
            // A telephony event, or end of one
            case 'kdeconnect.telephony':
                this._handleEvent(packet);
                break;

            // (Currently) this is always an answer to a request
            case 'kdeconnect.telephony.message':
                this._handleMessage(packet);
                break;

            default:
                logWarning('Unknown telephony packet', this.device.name);
        }
    }

    connected() {
        this.requestConversations();
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Array} messages - A list of telephony message objects
     */
    async _handleConversation(messages) {
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

        // TODO: sms.js could just do this on demand, but this way it
        // happens in a Promise and we know the last is the most recent...
        this._conversations[number] = messages.sort((a, b) => {
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
     * @param {kdeconnect.telephony.message} packet - An incoming packet
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
            let numbers = threads.map(t => t.address);

            for (let number in this._conversations) {
                if (!numbers.includes(number)) {
                    delete this._conversations[number];
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
     * Handle a regular telephony event.
     */
    _handleEvent(packet) {
        // This is the end of a 'ringing' or 'talking' event
        if (packet.body.hasOwnProperty('isCancel') && packet.body.isCancel) {
            this._onCancel(packet);
            return;
        }

        switch (packet.body.event) {
            case 'sms':
                if (this.settings.get_boolean('handle-sms')) {
                    this._onSms(packet);
                }
                break;

            case 'missedCall':
                if (this.settings.get_boolean('handle-calls')) {
                    this._onMissedCall(packet);
                }
                break;

            case 'ringing':
                if (this.settings.get_boolean('handle-calls')) {
                    this._onRinging(packet);
                }
                break;

            case 'talking':
                if (this.settings.get_boolean('handle-calls')) {
                    this._onTalking(packet);
                }
                break;
        }
    }

    /**
     * Update a contact's avatar from a JPEG ByteArray
     *
     * @param {kdeconnect.telephony} packet - A telephony packet
     * @param {Object} contact - A contact object
     */
    _updateAvatar(packet, contact) {
        if (packet.body.hasOwnProperty('phoneThumbnail') && !contact.avatar) {
            debug('updating avatar for ' + contact.name);

            contact.avatar = GLib.build_filenamev([
                Contacts.CACHE_DIR,
                GLib.uuid_string_random() + '.jpeg'
            ]);
            GLib.file_set_contents(
                contact.avatar,
                GLib.base64_decode(packet.body.phoneThumbnail)
            );
            this.contacts.notify('contacts');
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
     * Change volume, microphone and media player state in response to an
     * incoming or answered call.
     *
     * @param {String} eventType - 'ringing' or 'talking'
     */
    _setMediaState(eventType) {
        if (this.service.pulseaudio) {
            switch (this.settings.get_string(`${eventType}-volume`)) {
                case 'lower':
                    this.service.pulseaudio.lowerVolume();
                    break;

                case 'mute':
                    this.service.pulseaudio.muteVolume();
                    break;
            }

            if (eventType === 'talking' && this.settings.get_boolean('talking-microphone')) {
                this.service.pulseaudio.muteMicrophone();
            }
        }

        if (this.service.mpris && this.settings.get_boolean(`${eventType}-pause`)) {
            this.service.mpris.pauseAll();
        }
    }

    /**
     * Restore volume, microphone and media player state (if changed), making
     * sure to unpause before raising volume.
     */
    _restoreMediaState() {
        if (this.service.mpris) {
            this.service.mpris.unpauseAll();
        }

        if (this.service.pulseaudio) {
            this.service.pulseaudio.restore();
        }
    }

    /**
     * Update the conversations in any open windows for this device.
     */
    _updateConversations() {
        for (let window of this.service.get_windows()) {
            let isConversation = (window instanceof Sms.ConversationWindow);

            if (isConversation && window.device === this.device) {
                window._populateConversations();
            }
        }
    }

    /**
     * Show a local notification with actions appropriate for the call type:
     *   - missedCall: A button for replying by SMS
     *   - ringing: A button for muting the ringing
     *   - talking: none
     *
     * @param {Object} contact - A contact object
     * @param {Object} message - A telephony message object
     */
    callNotification(contact, message) {
        let buttons, icon, id, priority;

        if (contact && contact.avatar) {
            icon = Contacts.getPixbuf(contact.avatar);
        }

        if (message.event === 'missedCall') {
            buttons = [{
                action: 'replySms',
                // TRANSLATORS: Reply to a missed call by SMS
                label: _('Message'),
                parameter: GLib.Variant.full_pack(message)
            }];
            icon = icon || new Gio.ThemedIcon({ name: 'call-missed-symbolic' });
            // Use the notification ticker style for the id
            id = _('Missed call') + `: ${contact.name}`;
        } else if (message.event === 'ringing') {
            buttons = [{
                action: 'muteCall',
                // TRANSLATORS: Silence an incoming call
                label: _('Mute'),
                parameter: null
            }];
            icon = icon || new Gio.ThemedIcon({ name: 'call-start-symbolic' });
            priority = Gio.NotificationPriority.URGENT;
        } else if (message.event === 'talking') {
            icon = icon || new Gio.ThemedIcon({ name: 'call-start-symbolic' });
        }

        this.device.showNotification({
            id: id || `${message.event}|${contact.name}`,
            title: contact.name,
            body: message.body,
            icon: icon,
            priority: priority ? priority : Gio.NotificationPriority.NORMAL,
            buttons: (buttons) ? buttons : []
        });
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
            icon = Contacts.getPixbuf(contact.avatar);
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
     * Telephony event handlers
     */
    _parseEvent(packet) {
        // Ensure a contact exists for this event
        let contact = this.contacts.query({
            name: packet.body.contactName,
            number: packet.body.phoneNumber,
            single: true,
            create: true
        });

        // Update the avatar (if necessary)
        this._updateAvatar(packet, contact);

        // Fabricate a message packet from what we know
        let message = {
            contactName: contact.name,
            _id: 0,         // might be updated by sms.js
            thread_id: 0,   // might be updated by sms.js
            address: packet.body.phoneNumber || '',
            body: packet.body.messageBody,
            date: packet.id,
            event: packet.body.event,
            read: Sms.MessageStatus.UNREAD,
            type: Sms.MessageType.IN
        };

        if (message.event === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith
            message.body = _('Missed call from %s').format(contact.name);
        } else if (message.event === 'ringing') {
            // TRANSLATORS: eg. Incoming call from John Smith
            message.body = _('Incoming call from %s').format(contact.name);
        } else if (message.event === 'talking') {
            // TRANSLATORS: eg. Call in progress with John Smith
            message.body = _('Call in progress with %s').format(contact.name);
        }

        return [contact, message];
    }

    _onCancel(packet) {
        // Withdraw the (probably) open notification.
        this.device.hideNotification(`${packet.body.event}|${packet.body.contactName}`);
        this._restoreMediaState();
    }

    _onMissedCall(packet) {
        let [contact, message] = this._parseEvent(packet);

        // Start tracking the duplicate early
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            // TRANSLATORS: This is _specifically_ for matching missed call notifications on Android.
            // This should _exactly_ match the Android notification that in english looks like 'Missed call: John Lennon'
            notification.silenceDuplicate(_('Missed call') + `: ${contact.name}`);
        }

        this.callNotification(contact, message);
    }

    _onRinging(packet) {
        let [contact, message] = this._parseEvent(packet);

        this._setMediaState('ringing');
        this.callNotification(contact, message);
    }

    _onSms(packet) {
        let [contact, message] = this._parseEvent(packet);

        // Silence the duplicate as soon as possible
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            notification.silenceDuplicate(`${contact.name}: ${message.body}`);
        }

        // Try to update the conversation in time to open the window
        if (this.conversations.hasOwnProperty(packet.body.phoneNumber)) {
            this.requestConversation(
                this.conversations[packet.body.phoneNumber][0].thread_id
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

    _onTalking(packet) {
        debug(packet);

        let [contact, message] = this._parseEvent(packet);

        // Withdraw the 'ringing' notification
        this.device.hideNotification(`ringing|${contact.name}`);

        this._setMediaState('talking');
        this.callNotification(contact, message);
    }

    /**
     * Silence an incoming call
     */
    muteCall() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.telephony.request',
            body: { action: 'mute' }
        });

        this._restoreMediaState();
    }

    /**
     * Request a conversation, which is a list of messages from a single thread.
     *
     * @param {Number} thread_id - The thread_id of the conversation to request
     */
    requestConversation(thread_id) {
        this.device.sendPacket({
            type: 'kdeconnect.telephony.request_conversation',
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
            type: 'kdeconnect.telephony.request_conversations'
        });
    }

    /**
     * A notification action for replying to SMS messages (or missed calls).
     *
     * TODO: If the newer telephony.message packet is not supported, a mock
     *       packet fabricated by _onSms() will be logged in the window to
     * emulate it. If it is, the thread should have already been synced and only
     * the recipient will be set. Neither of these will happen if the window is
     * already open.
     *
     * @param {Object} message - A telephony message object
     */
    replySms(message) {
        // Check for an extant window
        let window = this._hasWindow(message.address);

        // Open a new window if not
        if (!window) {
            window = new Sms.ConversationWindow(this.device);
            window.urgency_hint = true;

            // Ensure we have a contact
            let contact = this.contacts.query({
                name: message.contactName,
                number: message.address,
                single: true,
                create: true
            });

            // Check if telephony.message packets are supported
            let msgs = this.device.get_outgoing_supported('telephony.message');

            // Set the recipient if it's a missed call or messages are supported
            if (message.event === 'missedCall' || msgs) {
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
            window = new Sms.ConversationChooser(this.device, url);

        // Open the list of contacts to start a new conversation
        } else {
            window = new Sms.ConversationWindow(this.device);
            window.setMessage(url);
        }

        window.present();
    }

    /**
     * Open and present a new SMS window
     */
    newSms() {
        let window = new Sms.ConversationWindow(this.device);
        window.present();
    }

    /**
     * This is the sms: URI scheme handler.
     */
    uriSms(uri) {
        debug(uri);

        if (!uri instanceof Sms.URI) {
            try {
                uri = new Sms.URI(uri);
            } catch (e) {
                debug('Error parsing sms URI: ' + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients[0]);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new Sms.ConversationWindow(this.device);

            for (let recipient of uri.recipients) {
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

