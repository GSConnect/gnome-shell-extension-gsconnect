'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Find My Phone'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone',
    incomingCapabilities: ['kdeconnect.findmyphone.request'],
    outgoingCapabilities: ['kdeconnect.findmyphone.request'],
    actions: {
        ring: {
            label: _('Ring'),
            icon_name: 'phonelink-ring-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.findmyphone.request']
        }
    }
};


/**
 * FindMyPhone Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/findmyphone
 *
 * TODO: cancel incoming requests on disconnect?
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhonePlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'findmyphone');
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.findmyphone.request') {
            this._handleRequest();
        }
    }

    /**
     * Handle an incoming location request.
     */
    _handleRequest() {
        try {
            // If this is a second request, stop announcing and return
            if (this._dialog) {
                this._dialog.response(Gtk.ResponseType.DELETE_EVENT);
                return;
            }

            this._dialog = new Dialog(this.device.name);
            this._dialog.connect('response', () => this._dialog = null);
        } catch (e) {
            this._cancelRequest();
            logError(e, this.device.name);
        }
    }

    _cancelRequest() {
        if (this._dialog) {
            this._dialog.response(Gtk.ResponseType.DELETE_EVENT);
        }
    }

    /**
     * Request the remote device announce it's location
     */
    ring() {
        this.device.sendPacket({
            type: 'kdeconnect.findmyphone.request',
            body: {}
        });
    }

    destroy() {
        this._cancelRequest();
        super.destroy();
    }
});


/**
 * Used to ensure 'audible-bell' is enabled for fallback
 */
const WM_SETTINGS = new Gio.Settings({
    schema_id: 'org.gnome.desktop.wm.preferences',
    path: '/org/gnome/desktop/wm/preferences/'
});


/**
 * A custom GtkMessageDialog for alerting of incoming requests
 */
const Dialog = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhoneDialog'
}, class Dialog extends Gtk.MessageDialog {
    _init(name) {
        super._init({
            buttons: Gtk.ButtonsType.CLOSE,
            image: new Gtk.Image({
                icon_name: 'phonelink-ring-symbolic',
                pixel_size: 512,
                halign: Gtk.Align.CENTER,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            }),
            urgency_hint: true
        });

        this.set_keep_above(true);
        this.maximize();
        this.message_area.destroy();

        // If the mixer is available start fading the volume up
        let service = Gio.Application.get_default();
        let mixer = service.components.get('pulseaudio');

        if (mixer) {
            this._stream = mixer.output;

            this._previousMuted = this._stream.muted;
            this._previousVolume = this._stream.volume;

            this._stream.muted = false;
            this._stream.fade(0.85, 15);

        // Otherwise ensure audible-bell is enabled
        } else {
            this._previousBell = WM_SETTINGS.get_boolean('audible-bell');
            WM_SETTINGS.set_boolean('audible-bell', true);
        }

        // Start the alarm
        let sound = service.components.get('sound');

        if (sound !== undefined) {
            sound.loopSound('phone-incoming-call', this.cancellable);
        }

        // Show the dialog
        this.show_all();
    }

    vfunc_key_press_event(event) {
        this.response(Gtk.ResponseType.DELETE_EVENT);

        return Gdk.EVENT_STOP;
    }

    vfunc_motion_notify_event(event) {
        this.response(Gtk.ResponseType.DELETE_EVENT);

        return Gdk.EVENT_STOP;
    }

    vfunc_response(response_id) {
        // Stop the alarm
        this.cancellable.cancel();

        // Restore the mixer level
        if (this._stream) {
            this._stream.muted = this._previousMuted;
            this._stream.fade(this._previousVolume);

        // Restore the audible-bell
        } else {
            WM_SETTINGS.set_boolean('audible-bell', this._previousBell);
        }

        this.destroy();
    }

    get cancellable() {
        if (this._cancellable === undefined) {
            this._cancellable = new Gio.Cancellable();
        }

        return this._cancellable;
    }
});

