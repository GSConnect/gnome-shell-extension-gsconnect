'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const Sms = imports.service.plugins.sms;


var Metadata = {
    label: _('Telephony'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony',
    incomingCapabilities: ['kdeconnect.telephony'],
    outgoingCapabilities: [
        'kdeconnect.telephony.request',
        'kdeconnect.telephony.request_mute'
    ],
    actions: {
        // Call Actions
        muteCall: {
            label: _('Mute Call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request']
        }
    }
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/TelephonyPlugin
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'telephony');

        this.contacts = this.service.contacts;
    }

    async handlePacket(packet) {
        try {
            // This is the end of a 'ringing' or 'talking' event
            if (packet.body.hasOwnProperty('isCancel') && packet.body.isCancel) {
                this._onCancel(packet);
                return;
            }

            // Ensure a contact exists for this event
            let contact = this.contacts.query({
                name: packet.body.contactName,
                number: packet.body.phoneNumber,
                create: true
            });

            // Update contact avatar
            if (packet.body.hasOwnProperty('phoneThumbnail')) {
                contact = await this.service.contacts.setAvatarContents(
                    contact.id,
                    GLib.base64_decode(packet.body.phoneThumbnail)
                );
            }

            let message = this._parseEvent(packet);

            // TODO: this is a backwards-compatiblity re-direct
            if (packet.body.event === 'sms') {
                // Only forward if the device doesn't support new packets
                if (!this.device.get_outgoing_supported('sms.messages')) {
                    let sms = this.device.lookup_plugin('sms');

                    if (sms !== null) {
                        sms._onSms(contact, message);
                    }
                }

                return;
            }

            switch (packet.body.event) {
                case 'missedCall':
                    this._onMissedCall(contact, message);
                    break;

                case 'ringing':
                    this._onRinging(contact, message);
                    break;

                case 'talking':
                    this._onTalking(contact, message);
                    break;
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Parse a telephony event and return an object like sms.messages
     *
     * @param {kdeconnect.telephony} packet - The telephony packet
     */
    _parseEvent(packet) {
        let contactName = packet.body.contactName || packet.body.phoneNumber;

        // Fabricate a message packet from what we know
        let message = {
            contactName: contactName,
            _id: 0,         // might be updated by sms.js
            thread_id: 0,   // might be updated by sms.js
            address: packet.body.phoneNumber || 'unknown',
            body: packet.body.messageBody,
            date: packet.id,
            event: packet.body.event,
            read: Sms.MessageStatus.UNREAD,
            type: Sms.MessageType.IN
        };

        if (message.event === 'missedCall') {
            // TRANSLATORS: eg. Missed call from John Smith
            message.body = _('Missed call from %s').format(contactName);
        } else if (message.event === 'ringing') {
            // TRANSLATORS: eg. Incoming call from John Smith
            message.body = _('Incoming call from %s').format(contactName);
        } else if (message.event === 'talking') {
            // TRANSLATORS: eg. Call in progress with John Smith
            message.body = _('Call in progress with %s').format(contactName);
        }

        return message;
    }

    _onCancel(packet) {
        // Withdraw the (probably) open notification.
        // TODO: it might choke on contactName here...
        this.device.hideNotification(`${packet.body.event}|${packet.body.contactName}`);
        this._restoreMediaState();
    }

    _onMissedCall(contact, message) {
        // Start tracking the duplicate early
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            // TRANSLATORS: This is _specifically_ for matching missed call notifications on Android.
            // This should _exactly_ match the Android notification that in english looks like 'Missed call: John Lennon'
            notification.silenceDuplicate(_('Missed call') + `: ${contact.name}`);
        }

        this.callNotification(contact, message);
    }

    _onRinging(contact, message) {
        this._setMediaState('ringing');
        this.callNotification(contact, message);
    }

    _onTalking(contact, message) {
        // Withdraw the 'ringing' notification
        this.device.hideNotification(`ringing|${contact.name}`);

        this._setMediaState('talking');
        this.callNotification(contact, message);
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
            icon = this.service.contacts.getPixbuf(contact.avatar);
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
     * Silence an incoming call
     */
    muteCall() {
        if (this.device.get_incoming_supported('telephony.request_mute')) {
            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.telephony.request_mute',
                body: {}
            });

        // TODO: backwards-compatibility kdeconnect-android <= 1.8.4
        } else {
            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.telephony.request',
                body: { action: 'mute' }
            });
        }

        this._restoreMediaState();
    }
});

