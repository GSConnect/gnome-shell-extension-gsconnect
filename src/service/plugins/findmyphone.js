'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Find My Phone'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone',
    incomingCapabilities: ['kdeconnect.findmyphone.request'],
    outgoingCapabilities: ['kdeconnect.findmyphone.request'],
    actions: {
        find: {
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
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhonePlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'findmyphone');

        this._cancellable = null;
        this._dialog = null;
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.findmyphone.request') {
            this._handleLocationRequest();
        }
    }

    /**
     * Handle an incoming location request.
     */
    _handleLocationRequest() {
        try {
            // If this is a second request, stop announcing and return
            if (this._cancellable !== null || this._dialog !== null) {
                this._endFind();
                return;
            }

            this._cancellable = new Gio.Cancellable();
            loop_theme_sound('phone-incoming-call', this._cancellable);

            this._dialog = new Gtk.MessageDialog({
                text: _('Locate Device'),
                secondary_text: _('%s asked to locate this device').format(
                    this.device.name
                ),
                urgency_hint: true,
                window_position: Gtk.WindowPosition.CENTER_ALWAYS,
                application: Gio.Application.get_default(),
                skip_pager_hint: true,
                visible: true
            });
            this._dialog.connect('delete-event', this._endFind.bind(this));
            this._dialog.connect('key-press-event', (dialog, event) => {
                if (event.get_keyval()[1] === Gdk.KEY_Escape) {
                    this._endFind();
                }
            });
            this._dialog.add_button(_('Found'), -4).connect(
                'clicked',
                this._endFind.bind(this)
            );
            this._dialog.set_keep_above(true);
            this._dialog.present();
        } catch (e) {
            this._endFind();
            logError(e, this.device.name);
        }
    }

    _endFind() {
        if (this._cancellable !== null) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._dialog !== null) {
            this._dialog.destroy()
            this._dialog = null;
        }
    }

    /**
     * Request the remote device announce it's location
     */
    find() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.findmyphone.request',
            body: {}
        });
    }

    destroy() {
        this._endFind();

        super.destroy();
    }
});

