'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


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
            outgoing: ['kdeconnect.findmyphone.request'],
        },
    },
};


/**
 * FindMyPhone Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/findmyphone
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhonePlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'findmyphone');

        this._dialog = null;
        this._player = Components.acquire('sound');
        this._mixer = Components.acquire('pulseaudio');
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.findmyphone.request':
                this._handleRequest();
                break;
        }
    }

    /**
     * Handle an incoming location request.
     */
    _handleRequest() {
        try {
            // If this is a second request, stop announcing and return
            if (this._dialog !== null) {
                this._dialog.response(Gtk.ResponseType.DELETE_EVENT);
                return;
            }

            this._dialog = new Dialog({
                device: this.device,
                plugin: this,
            });

            this._dialog.connect('response', () => {
                this._dialog = null;
            });
        } catch (e) {
            this._cancelRequest();
            logError(e, this.device.name);
        }
    }

    /**
     * Cancel any ongoing ringing and destroy the dialog.
     */
    _cancelRequest() {
        if (this._dialog !== null)
            this._dialog.response(Gtk.ResponseType.DELETE_EVENT);
    }

    /**
     * Request that the remote device announce it's location
     */
    ring() {
        this.device.sendPacket({
            type: 'kdeconnect.findmyphone.request',
            body: {},
        });
    }

    destroy() {
        this._cancelRequest();

        if (this._mixer !== undefined)
            this._mixer = Components.release('pulseaudio');

        if (this._player !== undefined)
            this._player = Components.release('sound');

        super.destroy();
    }
});


/*
 * Used to ensure 'audible-bell' is enabled for fallback
 */
const _WM_SETTINGS = new Gio.Settings({
    schema_id: 'org.gnome.desktop.wm.preferences',
    path: '/org/gnome/desktop/wm/preferences/',
});


/**
 * A custom GtkMessageDialog for alerting of incoming requests
 */
const Dialog = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhoneDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
    },
}, class Dialog extends Gtk.MessageDialog {
    _init(params) {
        super._init({
            buttons: Gtk.ButtonsType.CLOSE,
            device: params.device,
            image: new Gtk.Image({
                icon_name: 'phonelink-ring-symbolic',
                pixel_size: 512,
                halign: Gtk.Align.CENTER,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true,
            }),
            plugin: params.plugin,
            urgency_hint: true,
        });

        this.set_keep_above(true);
        this.maximize();
        this.message_area.destroy();

        // If an output stream is available start fading the volume up
        if (this.plugin._mixer && this.plugin._mixer.output) {
            this._stream = this.plugin._mixer.output;

            this._previousMuted = this._stream.muted;
            this._previousVolume = this._stream.volume;

            this._stream.muted = false;
            this._stream.fade(0.85, 15);

        // Otherwise ensure audible-bell is enabled
        } else {
            this._previousBell = _WM_SETTINGS.get_boolean('audible-bell');
            _WM_SETTINGS.set_boolean('audible-bell', true);
        }

        // Start the alarm
        if (this.plugin._player !== undefined)
            this.plugin._player.loopSound('phone-incoming-call', this.cancellable);

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
            _WM_SETTINGS.set_boolean('audible-bell', this._previousBell);
        }

        this.destroy();
    }

    get cancellable() {
        if (this._cancellable === undefined)
            this._cancellable = new Gio.Cancellable();

        return this._cancellable;
    }

    get device() {
        if (this._device === undefined)
            this._device = null;

        return this._device;
    }

    set device(device) {
        this._device = device;
    }

    get plugin() {
        if (this._plugin === undefined)
            this._plugin = null;

        return this._plugin;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }
});

