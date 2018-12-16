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
            icon_name: 'find-location-symbolic',

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
 * Return the backend to be used for playing sound effects
 *
 * @return {string|boolean} - 'gsound', 'libcanberra' or %false
 */
function get_backend() {
    if (window._SFX_BACKEND) {
        return _SFX_BACKEND;
    }

    // Service-wide GSound.Context singleton
    try {
        window._GSOUND_CONTEXT = new imports.gi.GSound.Context();
        window._GSOUND_CONTEXT.init(null);
        window._SFX_BACKEND = 'gsound';

    // Try falling back to libcanberra
    } catch (e) {
        if (GLib.find_program_in_path('canberra-gtk-play') !== null) {
            window._SFX_BACKEND = 'libcanberra';
        }
    }

    return _SFX_BACKEND;
}


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
                icon_name: 'find-location-symbolic',
                pixel_size: 128
            }),
            urgency_hint: true,
            window_position: Gtk.WindowPosition.CENTER_ALWAYS
        });

        this.set_keep_above(true);
        this.message_area.destroy();

        // Ensure the volume is sufficient
        let mixer = Gio.Application.get_default().pulseaudio;

        if (mixer) {
            this._stream = mixer.output;
            this._previousVolume = this._stream.volume;
            this._previousMuted = this._stream.muted;
            this._stream.volume = 0.85;
            this._stream.muted = false;
        }

        // Ensure audible-bell is enabled for fallback
        this._previousBell = WM_SETTINGS.get_boolean('audible-bell');
        WM_SETTINGS.set_boolean('audible-bell', true);

        // Show the dialog and start the alarm
        this.show_all();
        this._cancellable = new Gio.Cancellable();
        this.bell();
    }

    vfunc_response(response_id) {
        // Stop the alarm
        this._cancellable.cancel();

        // Restore the mixer level
        if (this._stream) {
            this._stream.volume = this._previousVolume;
            this._stream.muted = this._previousMuted;
        }

        // Restore the audible-bell
        WM_SETTINGS.set_boolean('audible-bell', this._previousBell);

        this.destroy();
    }

    bell() {
        let proc;

        switch (get_backend()) {
            case 'gsound':
                _GSOUND_CONTEXT.play_full(
                    {'event.id': 'phone-incoming-call'},
                    this._cancellable,
                    (source, res) => {
                        try {
                            source.play_full_finish(res);
                            this.bell();
                        } catch (e) {
                        }
                    }
                );
                break;

            case 'libcanberra':
                proc = new Gio.Subprocess({
                    argv: ['canberra-gtk-play', '-i', 'phone-incoming-call'],
                    flags: Gio.SubprocessFlags.NONE
                });
                proc.init(null);

                proc.wait_check_async(this._cancellable, (proc, res) => {
                    try {
                        proc.wait_check_finish(res);
                        this.bell();
                    } catch (e) {
                    }
                });
                break;

            default:
                this._display = Gdk.Display.get_default();
                this._fallback();
                GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    1500,
                    () => this._fallback()
                );
        }
    }

    /**
     * A fallback for playing an alert using gdk_display_bell() when neither
     * GSound nor canberra-gtk-play are available.
     */
    _fallback() {
        let count = 0;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            try {
                if (count++ < 4 && !this._cancellable.is_cancelled()) {
                    this._display.beep();
                    return GLib.SOURCE_CONTINUE;
                }

                return GLib.SOURCE_REMOVE;
            } catch (e) {
                return GLib.SOURCE_REMOVE;
            }
        });

        return !this._cancellable.is_cancelled();
    }
});

