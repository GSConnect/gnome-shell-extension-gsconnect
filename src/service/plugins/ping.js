"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Ping",
    incomingCapabilities: ["kdeconnect.ping"],
    outgoingCapabilities: ["kdeconnect.ping"],
    actions: {
        ping: {
            summary: _("Ping"),
            description: _("Ping a device with an optional message"),
            signature: "av",
            incoming: [],
            outgoing: ["kdeconnect.ping"],
            allow: 2
        }
    },
    events: {
        ping: {
            summary: _("Ping"),
            description: _("Ping a device with an optional message"),
            signature: "av",
            incoming: ["kdeconnect.ping"],
            outgoing: [],
            allow: 4
        }
    }
};


/**
 * Ping Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/ping
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPingPlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "ping");
    },

    handlePacket: function (packet) {
        debug("Ping: handlePacket()");

        // TODO
        if (!(this.allow & 4)) {
            return;
        }

        packet.body.message = packet.body.message || "";

        this.event("ping", packet.body.message);

        // Notification
        let notif = new Gio.Notification();
        notif.set_title(this.device.name);

        if (packet.body.message.length) {
            // TRANSLATORS: An optional message accompanying a ping, rarely if ever used
            // eg. Ping: A message sent with ping
            notif.set_body(_("Ping: %s").format(packet.body.message));
        } else {
            notif.set_body(_("Ping"));
        }

        notif.set_icon(
            new Gio.ThemedIcon({ name: this.device.type + "-symbolic" })
        );
        this.device.send_notification("ping", notif);
    },

    ping: function (message="") {
        debug("Ping: ping(" + message + ")");

        let packet = {
            id: 0,
            type: "kdeconnect.ping",
            body: {}
        };

        if (message.length) {
            packet.body.message = message;
        }

        this.device.sendPacket(packet);
    }
});

