'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
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
        muteCall: {
            label: _('Mute Call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request_mute']
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
            // This is the end of a 'ringing' or 'talking' event
            if (packet.body.isCancel) {
                let sender = packet.body.contactName || packet.body.phoneNumber;
                this.device.hideNotification(`${packet.body.event}|${sender}`);
                this._restoreMediaState();
                return;
            }

            // Take the opportunity to store the contact
            if (packet.body.phoneNumber) {
                let contact = this.device.contacts.query({
                    name: packet.body.contactName,
                    number: packet.body.phoneNumber
                });

                if (packet.body.phoneThumbnail) {
                    let data = GLib.base64_decode(packet.body.phoneThumbnail);
                    contact.avatar = await this.device.contacts.setAvatarContents(data);
                    this.device.contacts.update();
                }
            }

            // Only handle 'ringing' or 'talking' events, leave the notification
            // plugin to handle 'missedCall' and 'sms' since they're repliable
            if (['ringing', 'talking'].includes(packet.body.event)) {
                this._handleEvent(packet);
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

    /**
     * Load a Gdk.Pixbuf from base64 encoded data
     *
     * @param {string} data - Base64 encoded JPEG data
     */
    _getThumbnailPixbuf(data) {
        let loader;

        try {
            data = GLib.base64_decode(data);
            loader = new GdkPixbuf.PixbufLoader();
            loader.write(data);
            loader.close();
        } catch (e) {
            warning(e);
        }

        return loader.get_pixbuf();
    }

    /**
     * Show a local notification, possibly with actions
     *
     * @param {object} packet - A telephony packet for this event
     */
    _handleEvent(packet) {
        let body;
        let buttons = [];
        let icon = new Gio.ThemedIcon({name: 'call-start-symbolic'});
        let priority = Gio.NotificationPriority.NORMAL;

        // Ensure we have a sender
        // TRANSLATORS: No name or phone number
        let sender = _('Unknown Contact');

        if (packet.body.contactName) {
            sender = packet.body.contactName;
        } else if (packet.body.phoneNumber) {
            sender = packet.body.phoneNumber;
        }

        // If there's a photo, use it as the notification icon
        if (packet.body.phoneThumbnail) {
            icon = this._getThumbnailPixbuf(packet.body.phoneThumbnail);
        }

        if (packet.body.event === 'ringing') {
            this._setMediaState('ringing');

            // TRANSLATORS: The phone is ringing
            body = _('Incoming call');
            buttons = [{
                action: 'muteCall',
                // TRANSLATORS: Silence the phone ringer
                label: _('Mute'),
                parameter: null
            }];
            priority = Gio.NotificationPriority.URGENT;
        }

        if (packet.body.event === 'talking') {
            this.device.hideNotification(`ringing|${sender}`);
            this._setMediaState('talking');

            // TRANSLATORS: A phone call is active
            body = _('Ongoing call');
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

    /**
     * Silence an incoming call
     */
    muteCall() {
        this.device.sendPacket({
            type: 'kdeconnect.telephony.request_mute',
            body: {}
        });

        this._restoreMediaState();
    }
});

