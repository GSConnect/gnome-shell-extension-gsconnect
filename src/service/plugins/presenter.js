// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';

import * as Components from '../components/index.js';
import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Presentation'),
    description: _('Use the paired device as a presenter'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Presenter',
    incomingCapabilities: ['kdeconnect.presenter'],
    outgoingCapabilities: [],
    actions: {},
};


/**
 * Presenter Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/presenter
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/PresenterPlugin/
 */
const PresenterPlugin = GObject.registerClass({
    GTypeName: 'GSConnectPresenterPlugin',
}, class PresenterPlugin extends Plugin {

    _init(device) {
        super._init(device, 'presenter');

        if (!globalThis.HAVE_GNOME)
            this._input = Components.acquire('ydotool');
        else
            this._input = Components.acquire('input');
    }

    handlePacket(packet) {
        if (packet.body.hasOwnProperty('dx')) {
            this._input.movePointer(
                packet.body.dx * 1000,
                packet.body.dy * 1000
            );
        } else if (packet.body.stop) {
            // Currently unsupported and unnecessary as we just re-use the mouse
            // pointer instead of showing an arbitrary window.
        }
    }

    destroy() {
        if (this._input !== undefined) {
            if (!globalThis.HAVE_GNOME)
                this._input = Components.release('ydotool');
            else
                this._input = Components.release('input');
        }

        super.destroy();
    }
});

export default PresenterPlugin;
