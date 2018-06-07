'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Contacts = imports.modules.contacts;
const MPRIS = imports.modules.mpris;
const Sms = imports.modules.sms;
const Sound = imports.modules.sound;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony',
    incomingCapabilities: ['kdeconnect.telephony'],
    outgoingCapabilities: ['kdeconnect.telephony.request', 'kdeconnect.sms.request'],
    actions: {
        // Call Actions
        muteCall: {
            summary: _('Mute Call'),
            description: _('Silence an incoming call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request']
        },

        // SMS Actions
        newSms: {
            summary: _('New SMS'),
            description: _('Start a new SMS conversation'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        replySms: {
            summary: _('Reply SMS'),
            description: _('Reply to an SMS message'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        sendSms: {
            summary: _('Send SMS'),
            description: _('Send an SMS message'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        shareSms: {
            summary: _('Share SMS'),
            description: _('Share something by SMS message'),
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
 *
 * Packets:
 *  {
 *      type: 'kdeconnect.telephony'
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
    GTypeName: 'GSConnectTelephonyPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'telephony');

        this.contacts = Contacts.getStore();
        this.mixer = new Sound.Mixer();
        this.mpris = MPRIS.get_default();

    }

    handlePacket(packet) {
        debug(packet);

        let event = this._parsePacket(packet);

        // The event has ended (ringing stopped or call ended)
        if (packet.body.isCancel) {
            this._onCancel(event)
        // An event was triggered
        } else {
            switch (event.type) {
                case 'sms':
                    this._onSms(event);
                    break;
                case 'missedCall':
                    this._onMissedCall(event);
                    break;
                case 'ringing':
                    this._onRinging(event);
                    break;
                case 'talking':
                    this._onTalking(event);
                    break;
                default:
                    log('Unknown telephony event');
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
            debug('updating avatar for ' + event.contact.name);

            event.contact.avatar = GLib.build_filenamev([
                Contacts.CACHE_DIR,
                GLib.uuid_string_random() + '.jpeg'
            ]);
            GLib.file_set_contents(
                event.contact.avatar,
                GLib.base64_decode(packet.body.phoneThumbnail)
            );
            this.contacts._writeCache();
        }

        if (event.type === 'sms') {
            event.content = packet.body.messageBody;
        } else if (event.type === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            event.content = _('Missed call at %s').format(event.time);
        } else if (event.type === 'ringing') {
            // TRANSLATORS: eg. Incoming call from John Smith
            event.content = _('Incoming call from %s').format(event.contact.name);
        } else if (event.type === 'talking') {
            // TRANSLATORS: eg. Call in progress with John Smith
            event.content = _('Call in progress with %s').format(event.contact.name);
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

        if (event.type === 'missedCall') {
            buttons = [{
                action: 'replySms',
                // TRANSLATORS: Reply to a missed call by SMS
                label: _('Message'),
                parameter: gsconnect.full_pack(event)
            }];
            icon = icon || new Gio.ThemedIcon({ name: 'call-missed-symbolic' });
        } else if (event.type === 'ringing') {
            buttons = [{
                action: 'muteCall',
                // TRANSLATORS: Silence an incoming call
                label: _('Mute'),
                parameter: gsconnect.full_pack(event)
            }];
            icon = icon || new Gio.ThemedIcon({ name: 'call-start-symbolic' });
            priority = Gio.NotificationPriority.URGENT;
        } else if (event.type === 'talking') {
            icon = icon || new Gio.ThemedIcon({ name: 'call-start-symbolic' });
        }

        this.device.showNotification({
            id: `${event.type}|${event.contact.name}`,
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
            icon = new Gio.ThemedIcon({ name: 'sms-symbolic' });
        }

        this.device.showNotification({
            id: `sms|${event.contact.name}: ${event.content}`,
            title: event.contact.name,
            body: event.content,
            icon: icon,
            priority: Gio.NotificationPriority.HIGH,
            action: {
                name: 'replySms',
                parameter: gsconnect.full_pack(event)
            }
        });
    }

    _setMediaState(event) {
        switch (this.settings.get_string(`${event}-volume`)) {
            case 'lower':
                this.mixer.lowerVolume();
                break;

            case 'mute':
                this.mixer.muteVolume();
                break;
        }

        if (this.settings.get_boolean(`${event}-pause`)) {
            this.mpris.pauseAll();
        }

        if (event === 'talking' && this.settings.get_boolean('talking-microphone')) {
            this.mixer.muteMicrophone();
        }
    }

    _onCancel(event) {
        this.device.withdraw_notification(`${event.type}|${event.contact.name}`);
        // Unpause before restoring volume
        this.mpris.unpauseAll();
        this.mixer.restore();
    }

    /**
     * Telephony event handlers
     */
    _onMissedCall(event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get('notification');

        if (notification) {
            notification.markDuplicate({
                telId: event.type + '|' + event.time,
                // TRANSLATORS: This is _specifically_ for matching missed call notifications on Android.
                // This should _exactly_ match the Android notification that in english looks like 'Missed call: John Lennon'
                ticker: _('Missed call') + ': ' + event.contact.name,
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
                '<i>' + event.content + '</i>'
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.type,
                event.contact.name + ': ' + event.content
            ].join('|'));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    telId: event.type + '|' + event.time,
                    ticker: event.contact.name + ': ' + event.content,
                    isCancel: true
                });
            }
        }

        this.callNotification(event);
    }

    _onRinging(event) {
        debug(event);

        this.callNotification(event);
        this._setMediaState('ringing');
    }

    _onSms(event) {
        debug(event);

        // Start tracking the duplicate as soon as possible
        let notification = this.device._plugins.get('notification');
        let duplicate;

        if (notification) {
            duplicate = notification.markDuplicate({
                telId: `sms|${event.contact.name}: ${event.content}`,
                ticker: `${event.contact.name}: ${event.content}`
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
            window._notifications.push(`sms|${event.contact.name}: ${event.content}`);

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                duplicate = notification.markDuplicate({
                    telId: `sms|${event.contact.name}: ${event.content}`,
                    ticker: `${event.contact.name}: ${event.content}`,
                    isCancel: true
                });
            }
        }

        if (!duplicate) {
            this.smsNotification(event);
        }
    }

    _onTalking(event) {
        debug(event);

        // TODO: need this, or done by isCancel?
        this.device.withdraw_notification('ringing|' + event.contact.name);

        this.callNotification(event);
        this._setMediaState('talking');
    }

    /**
     * Check if there's an open conversation for a number(s)
     *
     * @param {string|array} phoneNumber - A string phone number or array of
     */
    _hasWindow(number) {
        debug(number);

        number = number.replace(/\D/g, '');

        // Get the current open windows
        let windows = this.device.service.get_windows();
        let conversation = false;

        // Look for an open window with this contact
        for (let index_ in windows) {
            let win = windows[index_];

            if (!win.device || win.device.id !== this.device.id) {
                continue;
            }

            if (number === win.number.replace(/\D/g, '')) {
                conversation = win;
                break;
            }
        }

        return conversation;
    }

    /**
     * Silence an incoming call
     */
    muteCall() {
        debug('');

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.telephony.request',
            body: { action: 'mute' }
        });
    }

    /**
     * Open and present a new SMS window
     */
    newSms() {
        debug('');

        let window = new Sms.ConversationWindow(this.device);
        window.present();
    }

    // FIXME FIXME
    openUri(uri) {
        debug('');

        if (!uri instanceof Sms.URI) {
            try {
                uri = new Sms.URI(uri);
            } catch (e) {
                debug('Error parsing sms URI: ' + e.message);
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
            let notification = this.device._plugins.get('notification');

            if (notification) {
                notification.markDuplicate({
                    telId: `sms|${event.contact.name}: ${event.content}`,
                    ticker: `${event.contact.name}: ${event.content}`,
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
     * Share a link by SMS message
     *
     * @param {string} url - The link to be shared
     */
    // FIXME: re-check
    shareSms(url) {
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

