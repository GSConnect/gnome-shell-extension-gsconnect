'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Telephony'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony',
    incomingCapabilities: [
        'kdeconnect.telephony',
    ],
    outgoingCapabilities: [
        'kdeconnect.telephony.request',
        'kdeconnect.telephony.request_mute',
    ],
    actions: {
        muteCall: {
            // TRANSLATORS: Silence the actively ringing call
            label: _('Mute Call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request_mute'],
        },
    },
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/TelephonyPlugin
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'telephony');

        // Neither of these are crucial for the plugin to work
        this._mpris = Components.acquire('mpris');
        this._mixer = Components.acquire('pulseaudio');
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.telephony':
                this._handleEvent(packet);
                break;
        }
    }

    /**
     * Change volume, microphone and media player state in response to an
     * incoming or answered call.
     *
     * @param {string} eventType - 'ringing' or 'talking'
     */
    _setMediaState(eventType) {
        // Mixer Volume
        if (this._mixer !== undefined) {
            switch (this.settings.get_string(`${eventType}-volume`)) {
                case 'restore':
                    this._mixer.restore();
                    break;

                case 'lower':
                    this._mixer.lowerVolume();
                    break;

                case 'mute':
                    this._mixer.muteVolume();
                    break;
            }

            if (eventType === 'talking' && this.settings.get_boolean('talking-microphone'))
                this._mixer.muteMicrophone();
        }

        // Media Playback
        if (this._mpris && this.settings.get_boolean(`${eventType}-pause`))
            this._mpris.pauseAll();
    }

    /**
     * Restore volume, microphone and media player state (if changed), making
     * sure to unpause before raising volume.
     *
     * TODO: there's a possibility we might revert a media/mixer state set for
     *       another device.
     */
    _restoreMediaState() {
        // Media Playback
        if (this._mpris)
            this._mpris.unpauseAll();

        // Mixer Volume
        if (this._mixer)
            this._mixer.restore();
    }

    /**
     * Load a Gdk.Pixbuf from base64 encoded data
     *
     * @param {string} data - Base64 encoded JPEG data
     * @return {Gdk.Pixbuf|null} A contact photo
     */
    _getThumbnailPixbuf(data) {
        let loader = new GdkPixbuf.PixbufLoader();

        try {
            data = GLib.base64_decode(data);
            loader.write(data);
            loader.close();
        } catch (e) {
            debug(e, this.device.name);
        }

        return loader.get_pixbuf();
    }

    /**
     * Handle a telephony event (ringing, talking), showing or hiding a
     * notification and possibly adjusting the media/mixer state.
     *
     * @param {Core.Packet} packet - A `kdeconnect.telephony`
     */
    _handleEvent(packet) {
        // Only handle 'ringing' or 'talking' events; leave the notification
        // plugin to handle 'missedCall' since they're often repliable
        if (!['ringing', 'talking'].includes(packet.body.event))
            return;

        // This is the end of a telephony event
        if (packet.body.isCancel)
            this._cancelEvent(packet);
        else
            this._notifyEvent(packet);
    }

    _cancelEvent(packet) {
        // Ensure we have a sender
        // TRANSLATORS: No name or phone number
        let sender = _('Unknown Contact');

        if (packet.body.contactName)
            sender = packet.body.contactName;
        else if (packet.body.phoneNumber)
            sender = packet.body.phoneNumber;

        this.device.hideNotification(`${packet.body.event}|${sender}`);
        this._restoreMediaState();
    }

    _notifyEvent(packet) {
        let body;
        let buttons = [];
        let icon = null;
        let priority = Gio.NotificationPriority.NORMAL;

        // Ensure we have a sender
        // TRANSLATORS: No name or phone number
        let sender = _('Unknown Contact');

        if (packet.body.contactName)
            sender = packet.body.contactName;
        else if (packet.body.phoneNumber)
            sender = packet.body.phoneNumber;

        // If there's a photo, use it as the notification icon
        if (packet.body.phoneThumbnail)
            icon = this._getThumbnailPixbuf(packet.body.phoneThumbnail);

        if (icon === null)
            icon = new Gio.ThemedIcon({name: 'call-start-symbolic'});

        // Notify based based on the event type
        if (packet.body.event === 'ringing') {
            this._setMediaState('ringing');

            // TRANSLATORS: The phone is ringing
            body = _('Incoming call');
            buttons = [{
                action: 'muteCall',
                // TRANSLATORS: Silence the actively ringing call
                label: _('Mute'),
                parameter: null,
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
            buttons: buttons,
        });
    }

    /**
     * Silence an incoming call and restore the previous mixer/media state, if
     * applicable.
     */
    muteCall() {
        this.device.sendPacket({
            type: 'kdeconnect.telephony.request_mute',
            body: {},
        });

        this._restoreMediaState();
    }

    destroy() {
        if (this._mixer !== undefined)
            this._mixer = Components.release('pulseaudio');

        if (this._mpris !== undefined)
            this._mpris = Components.release('mpris');

        super.destroy();
    }
});

