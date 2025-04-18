// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw';

import * as Components from '../components/index.js';
import Plugin from '../plugin.js';

export const Metadata = {
    label: _('Find My Phone'),
    description: _('Ring your paired device'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone',
    incomingCapabilities: ['kdeconnect.findmyphone.request'],
    outgoingCapabilities: ['kdeconnect.findmyphone.request'],
    actions: {
        ring: {
            label: _('Ring'),
            icon_name: 'phone-vibrate-symbolic',
            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.findmyphone.request'],
        },
    },
};

/*
 * Used to ensure 'audible-bell' is enabled for fallback
 */
const _WM_SETTINGS = new Gio.Settings({
    schema_id: 'org.gnome.desktop.wm.preferences',
    path: '/org/gnome/desktop/wm/preferences/',
});

const FindMyPhonePlugin = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhonePlugin',
}, class FindMyPhonePlugin extends Plugin {

    _init(device) {
        super._init(device, 'findmyphone');
        this._player = Components.acquire('sound');
        this._mixer = Components.acquire('pulseaudio');
        this._dialog = null;
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
            if (this._dialog !== null) {
                this._dialog.present();
                return;
            } else {
                this._dialog = new Dialog({
                    device: this.device,
                    plugin: this,
                });
                this._dialog.present();
            }
            
            this._dialog.connect('response', () => {
                this._dialog.hide();   
            });

        } catch (e) {
            this._cancelRequest();
            print(e + " - " + this.device.name);
        }
    }

    /**
     * Cancel any ongoing ringing and destroy the dialog.
     */
    _cancelRequest() {
        if (this._dialog !== null)
            this._dialog.response(Gtk.ResponseType.DELETE_EVENT);
    }

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
        
        this.run_dispose();
    }
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
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
    Signals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/find-my-phone.ui'
    
}, class Dialog extends Adw.ApplicationWindow {
    _init(params) {
        super._init();

        Object.assign(this, params);
        this._notificationId = 'findmyphone-notification';
        
        const motionController = new Gtk.EventControllerMotion();
        motionController.connect('motion', (controller, x, y) => {
            this.response(Gtk.ResponseType.DELETE_EVENT);
            return Gdk.EVENT_STOP;
        });

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            this.response(Gtk.ResponseType.DELETE_EVENT);
            return Gdk.EVENT_STOP;
        });

        // Aggiungi il controller alla finestra
        this.add_controller(motionController);
        this.add_controller(keyController);
    }

    present() {
        this._cancellable = new Gio.Cancellable();

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
            this.plugin._player.loopSound('phone-incoming-call', this._cancellable);

        this.emitNotification();
        super.present()
    }

    // Create a notification
    emitNotification(){
        const notification = Gio.Notification.new(_('Find My Phone'));
        notification.set_body(_('You found me!'));
        notification.set_priority(Gio.NotificationPriority.HIGH);
        
        // Add action to cancel request when notification is clicked
        notification.add_button(_('Stop Ringing'), `app.stop-ringing`);
        notification.set_default_action('app.stop-ringing');

        // Register action
        const action = new Gio.SimpleAction({ name: 'stop-ringing' });
        action.connect('activate', () => {
            this.response(Gtk.ResponseType.DELETE_EVENT);
            return Gdk.EVENT_STOP;
        });

        Gio.Application.get_default().add_action(action);
        // Send notification
        Gio.Application.get_default().send_notification(this._notificationId, notification);

    }

    response(response) {
        // Stop the alarm
        this._cancellable.cancel();

        // Restore the mixer level
        if (this._stream) {
            this._stream.muted = this._previousMuted;
            this._stream.fade(this._previousVolume);

        // Restore the audible-bell
        } else {
            _WM_SETTINGS.set_boolean('audible-bell', this._previousBell);
        }
        Gio.Application.get_default().withdraw_notification(this._notificationId);
        this.emit('response', this, response);
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

export default FindMyPhonePlugin;
