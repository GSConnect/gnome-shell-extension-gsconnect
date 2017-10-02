"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Notify = imports.gi.Notify;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "ping",
    incomingPackets: ["kdeconnect.ping"],
    outgoingPackets: ["kdeconnect.ping"]
};


/**
 * Ping Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/ping
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPingPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "ping": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "ping");
    },
    
    // TODO: play sound?
    handlePacket: function (packet) {
        Common.debug("Ping: handlePacket()");
        
        if (!packet.body.hasOwnProperty("message")) {
            packet.body.message = "";
        }
        
        this.emit("ping", packet.body.message);
        this._dbus.emit_signal(
            "ping",
            new GLib.Variant("(s)", [packet.body.message])
        );
        
        let body;
        
        if (packet.body.message.length) {
            body = _("Ping: %s").format(packet.body.message);
        } else {
            body = _("Ping");
        }
        
        let note = new Notify.Notification({
            app_name: "GSConnect",
            summary: this.device.name,
            body: body,
            icon_name: "phone-symbolic"
        });
        
        note.show();
    },
    
    ping: function (message="") {
        Common.debug("Ping: ping(" + message + ")");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.ping",
            body: {}
        });
        
        if (message.length) {
            packet.body.message = message;
        }
        
        this.device._channel.send(packet);
    }
});

