'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);

const Sound = imports.modules.sound;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone',
    incomingCapabilities: ['kdeconnect.findmyphone.request'],
    outgoingCapabilities: ['kdeconnect.findmyphone.request'],
    actions: {
        find: {
            summary: _('Locate'),
            description: _('Find a device by making it ring'),
            icon_name: 'find-location-symbolic',

            signature: null,
            incoming: [],
            outgoing: ['kdeconnect.findmyphone.request'],
            allow: 2
        }
    },
    events: {
        find: {
            summary: _('Locate'),
            description: _('Find a device by making it ring'),
            icon_name: 'find-location-symbolic',

            signature: null,
            incoming: [],
            outgoing: ['kdeconnect.findmyphone.request'],
            allow: 4
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

        this._desktop = new Gio.Settings({
            schema_id: 'org.gnome.system.location'
        });

        this._cancellable = null;
        this._dialog = null;

        this.device.menu.add_action('find', Metadata.actions.find);
    }

    handlePacket(packet) {
        debug('FindMyPhone: handlePacket()');

        if (packet.type === 'kdeconnect.findmyphone.request' && (this.allow & 4)) {
            this._handleFind();
        }
    }

    /**
     * Local Methods
     */
    _handleFind() {
        debug('FindMyPhone: _ring()');

        if (this._cancellable || this._dialog) {
            this._endFind();
        }

        this._cancellable = new Gio.Cancellable();
        Sound.loopThemeSound('phone-incoming-call', this._cancellable);

        this._dialog = new Gtk.MessageDialog({
            text: _('Locate Device'),
            secondary_text: _('%s asked to locate this device').format(this.device.name),
            urgency_hint: true,
            window_position: Gtk.WindowPosition.CENTER_ALWAYS,
            application: Gio.Application.get_default(),
            skip_pager_hint: true,
            skip_taskbar_hint: true,
            visible: true
        });
        this._dialog.connect('delete-event', () => this._endFind());
        this._dialog.connect('key-press-event', (dialog, event) => {
            if (event.get_keyval()[1] === Gdk.KEY_Escape) {
                this._endFind();
            }
        });
        this._dialog.add_button(_('Found'), -4).connect('clicked', () => {
            this._endFind();
        });
        this._dialog.set_keep_above(true);
        this._dialog.present();

        return true;
    }

    _endFind() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._dialog.destroy()
        this._dialog = null;
    }

    /**
     * Remote Methods
     */
    find() {
        debug(this.device.name);

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.findmyphone.request',
            body: {}
        });
    }

    destroy() {
        if (this._cancellable || this._dialog) {
            this._endFind();
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

