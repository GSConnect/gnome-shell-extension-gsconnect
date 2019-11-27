'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const TelephonyUI = imports.service.ui.telephony;


var Metadata = {
    label: _('Telephony'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony',
    incomingCapabilities: ['kdeconnect.telephony'],
    outgoingCapabilities: [
        'kdeconnect.telephony.request',
        'kdeconnect.telephony.request_mute'
    ],
    actions: {
        legacyReply: {
            // TRANSLATORS: Respond to an incoming call via SMS
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.sms.request']
        },
        muteCall: {
            // TRANSLATORS: Silence the actively ringing call
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

    get legacy_sms() {
        // We have to do this lookup each time, because if we hold a reference
        // to the plugin we don't know if it's disabled
        let sms = this.device._plugins.get('sms');
        return (sms && sms.settings.get_boolean('legacy-sms'));
    }

    async handlePacket(packet) {
        try {
            // This is the end of a 'ringing' or 'talking' event
            if (packet.body.isCancel) {
                let sender = packet.body.contactName || packet.body.phoneNumber;
                this.device.hideNotification(`${packet.body.event}|${sender}`);
                this._restoreMediaState();

            // Only handle 'ringing' or 'talking' events, leave the notification
            // plugin to handle 'missedCall' and 'sms' since they're repliable
            } else if (['ringing', 'talking'].includes(packet.body.event)) {
                this._handleEvent(packet);

            // Legacy messaging support
            } else if (packet.body.event === 'sms' && this.legacy_sms) {
                this._handleLegacyMessage(packet);
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
        // Mixer Volume
        let pulseaudio = this.service.components.get('pulseaudio');

        if (pulseaudio) {
            switch (this.settings.get_string(`${eventType}-volume`)) {
                case 'lower':
                    pulseaudio.lowerVolume();
                    break;

                case 'mute':
                    pulseaudio.muteVolume();
                    break;
            }

            if (eventType === 'talking' && this.settings.get_boolean('talking-microphone')) {
                pulseaudio.muteMicrophone();
            }
        }

        // Media Playback
        let mpris = this.service.components.get('mpris');

        if (mpris && this.settings.get_boolean(`${eventType}-pause`)) {
            mpris.pauseAll();
        }
    }

    /**
     * Restore volume, microphone and media player state (if changed), making
     * sure to unpause before raising volume.
     */
    _restoreMediaState() {
        // Media Playback
        let mpris = this.service.components.get('mpris');

        if (mpris) {
            mpris.unpauseAll();
        }

        // Mixer Volume
        let pulseaudio = this.service.components.get('pulseaudio');

        if (pulseaudio) {
            pulseaudio.restore();
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
            debug(e);
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
                // TRANSLATORS: Silence the actively ringing call
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

    _handleLegacyMessage(packet) {
        let action = null;
        let icon = new Gio.ThemedIcon({name: 'sms-symbolic'});

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

        // If there's a phone number we can make this repliable
        if (packet.body.phoneNumber) {
            action = {
                name: 'legacyReply',
                parameter: GLib.Variant.full_pack(packet)
            };
        }

        // Show notification
        this.device.showNotification({
            id: `${packet.body.event}|${sender}`,
            title: sender,
            body: packet.body.messageBody,
            icon: icon,
            priority: Gio.NotificationPriority.NORMAL,
            action: action
        });
    }

    legacyReply(packet) {
        try {
            let plugin = this.device._plugins.get('sms');

            if (plugin === undefined) {
                throw new Error('SMS Plugin is disabled');
            }

            let dialog = new TelephonyUI.LegacyMessagingDialog({
                device: this.device,
                message: {
                    date: packet.id,
                    addresses: [{address: packet.body.phoneNumber}],
                    body: packet.body.messageBody,
                    sender: packet.body.contactName || _('Unknown Contact'),
                    type: 1 // MessageBox.INBOX
                },
                plugin: plugin
            });
            dialog.present();
        } catch (e) {
            logError(e);
        }
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

