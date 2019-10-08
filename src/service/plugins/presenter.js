'use strict';

const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Presentation'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Presenter',
    incomingCapabilities: ['kdeconnect.presenter'],
    outgoingCapabilities: [],
    actions: {}
};


/**
 * Presenter Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/presenter
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/PresenterPlugin/
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPresenterPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'presenter');

        this._input = this.service.components.get('input');
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
});

