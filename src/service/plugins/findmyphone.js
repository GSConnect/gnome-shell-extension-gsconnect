// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

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
            icon_name: 'phonelink-ring-symbolic',
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
        this._notificationId = 'findmyphone-notification';
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.findmyphone.request') {
            this._handleRequest();
        }
    }

    _handleRequest() {
        try {
            // Create a notification
            const notification = Gio.Notification.new(_('Find My Phone'));
            notification.set_body(_('GSConnect has updated to support changes to the KDE Connect protocol. Some devices may need to be repaired.'));
            notification.set_priority(Gio.NotificationPriority.HIGH);
            
            // Add action to cancel request when notification is clicked
            notification.add_button(_('Stop Ringing'), `app.stop-ringing`);
            notification.set_default_action('app.stop-ringing');

            // Register action
            const action = new Gio.SimpleAction({ name: 'stop-ringing' });
            action.connect('activate', () => {
                this._cancelRequest();
            });
            Gio.Application.get_default().add_action(action);
            // Send notification
            Gio.Application.get_default().send_notification(this._notificationId, notification);
            
            
            // If an output stream is available start fading the volume up
            if (this._mixer && this._mixer.output) {
                this._stream = this._mixer.output;

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
            this._player.loopSound('phone-incoming-call', this.cancellable);

        } catch (e) {
            this._cancelRequest();
            logError(e, this.device.name);
        }
    }

    _cancelRequest() {

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

        Gio.Application.get_default().withdraw_notification(this._notificationId);
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

        super.run_dispose();
    }
});

export default FindMyPhonePlugin;
