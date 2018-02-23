"use strict";

const Lang = imports.lang;

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand",
    incomingCapabilities: ["kdeconnect.runcommand", "kdeconnect.runcommand.request"],
    outgoingCapabilities: ["kdeconnect.runcommand", "kdeconnect.runcommand.request"],
    actions: {
        executeCommand: {
            summary: _("Run Commands"),
            description: _("Execute local commands remotely"),
            signature: "av",
            incoming: ["kdeconnect.runcommand"],
            outgoing: ["kdeconnect.runcommand.request"],
            allow: 2
        }
    },
    events: {}
};


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommands
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/runcommand
 */
var Plugin = new Lang.Class({
    Name: "GSConnectRunCommandPlugin",
    Extends: PluginsBase.Plugin,
    Properties: {
        "commands": GObject.ParamSpec.string(
            "commands",
            "DeviceCommandList",
            "A string of JSON containing the remote commands",
            GObject.ParamFlags.READABLE,
            "{}"
        )
    },

    _init: function (device) {
        this.parent(device, "runcommand");

        this.settings.connect("changed::command-list", () => {
            this._handleRequest();
        });

        this._commands = "{}";
        this.notify("commands");
        this.request();
    },

    get commands () {
        return this._commands;
    },

    handlePacket: function (packet) {
        debug(packet);

        return new Promise((resolve, reject) => {
            // Request for command list or execution
            if (packet.type === "kdeconnect.runcommand.request") {
                if (packet.body.requestCommandList) {
                    this._handleRequest();
                } else if (packet.body.key) {
                    this._handleExecute(key);
                }
            // A list of the remote device's commands
            } else if (packet.type === "kdeconnect.runcommand") {
                this._commands = packet.body.commandList;
                this.notify("commands");
            }
        });
    },

    /**
     * Local Methods
     */
    _handleRequest: function () {
        debug("...");

        this.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand",
            body: { commandList: this.settings.get_string("command-list") }
        });
    },

    _handleExecute: function (key) {
        debug(key);

        let commands = JSON.parse(this.settings.get_string("command-list"));
        if (commands.hasOwnProperty(packet.body.key)) {
            GLib.spawn_async(
                null, // working_dir
                ["/bin/sh", "-c", commands[packet.body.key].command],
                null, // envp
                GLib.SpawnFlags.DEFAULT, // flags
                null // GLib.SpawnChildSetupFunc
            );
        }
    },

    /**
     * Remote Methods
     */
    request: function () {
        this.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { requestCommandList: true }
        });
    },

    /**
     * Run the remote command @key
     * @param {string} key - The key of the remote command
     */
    run: function (key) {
        this.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { key: key }
        });
    }
});

