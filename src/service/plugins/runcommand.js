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

const { initTranslations, Me, DBusInfo, Settings } = imports.common;
const Config = imports.service.config;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "runcommand",
    incomingPackets: ["kdeconnect.runcommand.request"],
    outgoingPackets: ["kdeconnect.runcommand"],
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
    
    _init: function (device) {
        this.parent(device, "runcommand");
        
        this.settings = this.device.config.plugins[this.name].settings;
    },
    
    // TODO
    handle_packet: function (packet) {
        if (packet.body.hasOwnProperty("requestCommandList")) {
            this.sendCommandList();
        } else if (packet.body.hasOwnProperty("key")) {
            if (this.settings.commands.hasOwnProperty(packet.body.key)) {
                GLib.spawn_command_line_async(
                    "/bin/sh -c " + this.settings.commands[packet.body.key].command
                );
            }
        }
    },
    
    sendCommandList: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.runcommand";
            packet.body = {
                commandList: JSON.stringify(this.settings.commands)
            };
            
            this.device._channel.send(packet);
        }
    }
});

