// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Keep Awake'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.ScreensaverInhibit',
    description: _('Keep the screen on and unlocked while the device is connected'),
    enabledByDefault: false,
    incomingCapabilities: [],
    outgoingCapabilities: [],
    actions: {},
};


/**
 * ScreensaverInhibit Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/screensaver-inhibit
 *
 * Stops the session from going idle, which would blank and lock the screen,
 * while the device is connected. It sends and receives no packets.
 */
const ScreensaverInhibitPlugin = GObject.registerClass({
    GTypeName: 'GSConnectScreensaverInhibitPlugin',
}, class ScreensaverInhibitPlugin extends Plugin {

    _init(device) {
        super._init(device, 'screensaver_inhibit');

        this._cookie = 0;
    }

    connected() {
        super.connected();

        if (this._cookie !== 0 || this.device.service === null)
            return;

        this._cookie = this.device.service.inhibit(
            null,
            Gtk.ApplicationInhibitFlags.IDLE,
            // TRANSLATORS: The reason the screen is kept on (eg. Google Pixel is connected)
            _('%s is connected').format(this.device.name)
        );
    }

    disconnected() {
        super.disconnected();

        this._uninhibit();
    }

    _uninhibit() {
        if (this._cookie === 0)
            return;

        this.device.service?.uninhibit(this._cookie);
        this._cookie = 0;
    }

    destroy() {
        this._uninhibit();

        super.destroy();
    }
});

export default ScreensaverInhibitPlugin;
