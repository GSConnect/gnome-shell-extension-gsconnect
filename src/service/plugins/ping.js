"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
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
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent(device, "ping");
    },
    
    // TODO: support pings with messages
    //       notification
    handlePacket: function (packet) {
        this.emit("ping");
        log("IMPLEMENT: " + packet.toString());
    },
    
    // TODO: support pings with messages
    ping: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.ping";
            
            this.device._channel.send(packet);
        }
    }
});

