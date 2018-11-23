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
            label: _('Locate'),
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
 * A custom GtkMessageDialog for alerting of incoming requests
 */
const Dialog = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhoneDialog'
}, class Dialog extends Gtk.MessageDialog {
    _init(name) {
        super._init({
            text: _('Locate Device'),
            secondary_text: _('%s asked to locate this device').format(name),
            urgency_hint: true,
            window_position: Gtk.WindowPosition.CENTER_ALWAYS,
            visible: true
        });

        this.set_keep_above(true);
        this.add_button(_('Found'), Gtk.ResponseType.DELETE_EVENT);

        //
        this._cancellable = new Gio.Cancellable();
        this.bell();
    }

    vfunc_response(response_id) {
        this._cancellable.cancel();
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
                this._fallback();
                GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    1500,
                    () => this._fallback()
                );
        }
    }

    /**
     * A fallback for playing an alert using gtk_widget_error_bell() when
     * neither GSound or libcanberra are available.
     *
     * TODO: ensure system volume is sufficient?
     */
    _fallback() {
        let count = 0;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            try {
                if (count++ < 4 && !this._cancellable.is_cancelled()) {
                    this.error_bell();
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

