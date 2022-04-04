// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


// decide if it is under gnome-shell
var HAVE_GNOME = true;
try {
// eslint-disable-next-line no-unused-expressions
    imports.ui;
} catch (e) {
    debug('Not under gnome-shell');
    HAVE_GNOME = false;
    imports.wl_clipboard.watchService();
}
var Metadata = {
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
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPresenterPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'presenter');

        if (!HAVE_GNOME)
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
            if (!HAVE_GNOME)
                this._input = Components.release('ydotool');
            else
                this._input = Components.release('input');
        }

        super.destroy();
    }
});
