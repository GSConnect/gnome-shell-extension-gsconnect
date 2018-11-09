'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Ping'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Ping',
    incomingCapabilities: ['kdeconnect.ping'],
    outgoingCapabilities: ['kdeconnect.ping'],
    actions: {
        ping: {
            label: _('Ping'),
            icon_name: 'dialog-information-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.ping']
        }
    }
};


/**
 * Ping Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/ping
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPingPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'ping');
    }

    handlePacket(packet) {
        debug(packet);

        // Notification
        let notif = {
            title: this.device.name,
            body: _('Ping'),
            icon: new Gio.ThemedIcon({name: `${this.device.icon_name}-symbolic`})
        };

        if (packet.body.message) {
            // TRANSLATORS: An optional message accompanying a ping, rarely if ever used
            // eg. Ping: A message sent with ping
            notif.body = _('Ping: %s').format(packet.body.message);
        }

        this.device.showNotification(notif);
    }

    ping(message = '') {
        debug(message);

        let packet = {
            id: 0,
            type: 'kdeconnect.ping',
            body: {}
        };

        if (message.length) {
            packet.body.message = message;
        }

        this.device.sendPacket(packet);
    }
});

