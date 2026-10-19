// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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

const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';

/*
 * Used to ensure 'audible-bell' is enabled for fallback
 */
const _WM_SETTINGS = new Gio.Settings({
    schema_id: 'org.gnome.desktop.wm.preferences',
    path: '/org/gnome/desktop/wm/preferences/',
});


/**
 * FindMyPhone Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/findmyphone
 */
const FindMyPhonePlugin = GObject.registerClass({
    GTypeName: 'GSConnectFindMyPhonePlugin',
}, class FindMyPhonePlugin extends Plugin {

    _init(device) {
        super._init(device, 'findmyphone');

        this._ringingCancellable = null;
        this._notificationId = 0;
        this._notificationSignalIds = [];
        this._player = Components.acquire('sound');
        this._mixer = Components.acquire('pulseaudio');
    }

    disconnected() {
        super.disconnected();
        this.stopRinging();
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
            if (this._ringingCancellable !== null) {
                this.stopRinging();
                return;
            }

            this._startRinging();
        } catch (e) {
            this.stopRinging();
            logError(e, this.device.name);
        }
    }

    /**
     * Start the alarm and show a notification for silencing it.
     */
    _startRinging() {
        this._ringingCancellable = new Gio.Cancellable();

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
        if (this._player !== undefined)
            this._player.loopSound('phone-incoming-call', this._ringingCancellable);

        this._showNotification();
    }

    /**
     * Show a notification for silencing the alarm.
     *
     * This uses the Freedesktop notification service directly, since unlike
     * GNotification it reports when the notification is dismissed.
     */
    _showNotification() {
        const connection = Gio.DBus.session;
        const ringing = this._ringingCancellable;

        // Subscribe first, so a close can't be missed
        this._notificationSignalIds = [
            'NotificationClosed',
            'ActionInvoked',
        ].map(signal => connection.signal_subscribe(
            NOTIFICATIONS_NAME,
            NOTIFICATIONS_NAME,
            signal,
            NOTIFICATIONS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _name, parameters) => {
                const [id] = parameters.deepUnpack();

                if (id === this._notificationId)
                    this.stopRinging();
            }
        ));

        connection.call(
            NOTIFICATIONS_NAME,
            NOTIFICATIONS_PATH,
            NOTIFICATIONS_NAME,
            'Notify',
            new GLib.Variant('(susssasa{sv}i)', [
                GLib.get_application_name(),
                0,
                'phonelink-ring-symbolic',
                this.device.name,
                // TRANSLATORS: The device asked this computer to ring, eg. to find it
                _('Ringing this device'),
                // The default action is used when the notification is clicked
                ['default', _('Silence'), 'silence', _('Silence')],
                {
                    'desktop-entry': new GLib.Variant('s', 'org.gnome.Shell.Extensions.GSConnect'),
                    'urgency': new GLib.Variant('y', 2),
                },
                0,
            ]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (_connection, result) => {
                try {
                    const [id] = connection.call_finish(result).deepUnpack();

                    // Stopped while the notification was being shown
                    if (this._ringingCancellable !== ringing)
                        this._closeNotification(id, false);
                    else
                        this._notificationId = id;
                } catch (e) {
                    // Without a notification there'd be no way to silence it
                    logError(e, this.device.name);

                    if (this._ringingCancellable === ringing)
                        this.stopRinging();
                }
            }
        );
    }

    /**
     * Withdraw the notification and stop listening for it being closed.
     *
     * @param {number} id - The notification id
     * @param {boolean} [current] - Whether it belongs to the current alarm
     */
    _closeNotification(id, current = true) {
        const connection = Gio.DBus.session;

        if (current) {
            for (const signalId of this._notificationSignalIds)
                connection.signal_unsubscribe(signalId);

            this._notificationSignalIds = [];
            this._notificationId = 0;
        }

        if (id === 0)
            return;

        connection.call(
            NOTIFICATIONS_NAME,
            NOTIFICATIONS_PATH,
            NOTIFICATIONS_NAME,
            'CloseNotification',
            new GLib.Variant('(u)', [id]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    /**
     * Stop the alarm, restore the mixer level and withdraw the notification.
     */
    stopRinging() {
        if (this._ringingCancellable === null)
            return;

        // Unsubscribe before closing, which would be reported back otherwise
        const id = this._notificationId;

        // Stop the alarm
        this._ringingCancellable.cancel();
        this._ringingCancellable = null;

        // Restore the mixer level
        if (this._stream) {
            this._stream.muted = this._previousMuted;
            this._stream.fade(this._previousVolume);
            this._stream = null;

        // Restore the audible-bell
        } else {
            _WM_SETTINGS.set_boolean('audible-bell', this._previousBell);
        }

        this._closeNotification(id);
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
        this.stopRinging();

        if (this._mixer !== undefined)
            this._mixer = Components.release('pulseaudio');

        if (this._player !== undefined)
            this._player = Components.release('sound');

        super.destroy();
    }
});

export default FindMyPhonePlugin;
