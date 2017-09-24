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
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const PluginsBase = imports.plugins.base;

const Config = imports.service.config;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


var METADATA = {
    name: "runcommand",
    incomingPackets: ["kdeconnect.runcommand"],
    outgoingPackets: ["kdeconnect.runcommand.request"],
    settings: { commands: {} }
};


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommand
 *
 * TODO: some new stuff was added to git
 */
var Plugin = new Lang.Class({
    Name: "GSConnectRunCommandPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "runcommand": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent(device, "remotecommand");
        //GLib.uuid_string_random();
        
        if (METADATA.hasOwnProperty("settings")) {
            this.settings = this.device.config.plugins[this.name].settings;
        }
    },
    
    get incomingPackets() {
        return ["kdeconnect.runcommand.request"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.runcommand"];
    },
    
    // TODO
    handle_packet: function (packet) {
        this.emit("runcommand");
        log("IMPLEMENT: " + packet.toString());
    },
    
    runcommand: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.runcommand";
            
            this.device._channel.send(packet);
        }
    }
});
