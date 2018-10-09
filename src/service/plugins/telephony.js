'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


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
    }

    async handlePacket(packet) {
        try {
            let contact;

            // This is the end of a 'ringing' or 'talking' event
            if (packet.body.isCancel) {
                let sender = packet.body.contactName || packet.body.phoneNumber;
                this.device.hideNotification(`${packet.body.event}|${sender}`);
                this._restoreMediaState();
                return;
            }

            // Take the opportunity to store the contact
            if (packet.body.phoneNumber) {
                contact = this.device.contacts.query({
                    name: packet.body.contactName,
                    number: packet.body.phoneNumber,
                    create: true
                });

                if (packet.body.phoneThumbnail) {
                    let data = GLib.base64_decode(packet.body.phoneThumbnail);
                    contact.avatar = await this._store.setAvatarContents(data);
                    this.device.contacts.update();
                }
            }

            switch (packet.body.event) {
                case 'ringing':
                case 'talking':
                    this._handleCall(packet);
                    break;

                case 'sms':
                    this._handleMessage(packet);
                    break;
            }
        } catch (e) {
            logError(e);
        }
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

    _getPixbuf(data) {
        // Catch errors from partially corrupt JPEGs as warnings
        let loader;

        try {
            loader = new GdkPixbuf.PixbufLoader();
            loader.write(data);
            loader.close();
        } catch (e) {
            logWarning(e);
        }

        return loader.get_pixbuf();
    }

    /**
     * Show a local notification, possibly with actions
     *
     * @param {object} packet - A telephony packet for this event
     */
    _handleCall(packet) {
        let body;
        let buttons = [];
        let icon = new Gio.ThemedIcon({ name: 'call-start-symbolic' });
        let priority = Gio.NotificationPriority.NORMAL;
        let sender = packet.body.contactName || packet.body.phoneNumber;

        // If there's a photo, use it as the notification icon
        if (packet.body.phoneThumbnail) {
            let data = GLib.base64_decode(packet.body.phoneThumbnail);
            icon = this._getPixbuf(data);
        }

        // An incoming call
        if (packet.body.event === 'ringing') {
            this._setMediaState('ringing');

            // TRANSLATORS: eg. Incoming call from John Smith
            body = _('Incoming call from %s').format(sender);
            buttons = [{
                action: 'muteCall',
                // TRANSLATORS: Silence an incoming call
                label: _('Mute'),
                parameter: null
            }];
            priority = Gio.NotificationPriority.URGENT;
        }

        // An in progress call
        if (packet.body.event === 'talking') {
            this.device.hideNotification(`ringing|${sender}`);
            this._setMediaState('talking');

            // TRANSLATORS: eg. Call in progress with John Smith
            body = _('Call in progress with %s').format(sender);
        }

        this.device.showNotification({
            id: `${packet.body.event}|${sender}`,
            title: sender,
            body: body,
            icon: icon,
            priority: priority,
            buttons: buttons
        });
    }

    _handleMessage(packet) {
        if (!packet.body.phoneNumber) {
            return;
        }

        // track the duplicate as soon as possible
        let notification = this.device.lookup_plugin('notification');

        if (notification) {
            let sender = packet.body.contactName || packet.body.phoneNumber;
            notification.trackDuplicate(
                `${sender}: ${packet.body.messageBody}`,
                packet.body.phoneNumber
            );
        }

        // Bail if SMS is disabled or the device supports the new packets
        let sms = this.device.lookup_plugin('sms');

        if (!sms || this.device.get_outgoing_supported('sms.messages')) {
            return;
        }

        // Fabricate a message packet from what we know
        let message = {
            _id: 0,
            thread_id: GLib.MAXINT32,
            address: packet.body.phoneNumber,
            body: packet.body.messageBody,
            date: packet.id,
            event: packet.body.event,
            read: 0,
            type: 1
        };

        sms._handleMessage(contact, message);
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

