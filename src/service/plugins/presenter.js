'use strict';

const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Presentation'),
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
        if (this._input !== undefined)
            this._input = Components.release('input');

        super.destroy();
    }
});

