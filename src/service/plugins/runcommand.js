"use strict";

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
var Plugin = GObject.registerClass({
    GTypeName: "GSConnectRunCommandPlugin",
    Properties: {
        "commands": GObject.param_spec_variant(
            "commands",
            "DeviceCommands",
            "A dictionary of remote commands",
            new GLib.VariantType("a{sv}"),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, "runcommand");

        // Local Commands
        this.settings.connect("changed::command-list", this._handleRequest.bind(this));

        this._commands = {};
        this.notify("commands");
        this.request();
    }

    get commands () {
        return this._commands || {};
    }

    handlePacket(packet) {
        debug(packet);

        // Request for command list or execution
        if (packet.type === "kdeconnect.runcommand.request") {
            if (packet.body.requestCommandList) {
                this._handleRequest();
            } else if (packet.body.key) {
                this._handleExecute(packet.body.key);
            }
        // A list of the remote device's commands
        } else if (packet.type === "kdeconnect.runcommand") {
            this._commands = packet.body.commandList;
            this.notify("commands");
        }
    }

    /**
     * Local Methods
     */
    _handleRequest() {
        debug("...");

        let commands = gsconnect.full_unpack(
            this.settings.get_value("command-list")
        );

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand",
            body: { commandList: commands }
        });
    }

    _handleExecute(key) {
        debug(key);

        let commands = gsconnect.full_unpack(
            this.settings.get_value("command-list")
        );

        if (commands.hasOwnProperty(key)) {
            GLib.spawn_async(
                null, // working_dir
                ["/bin/sh", "-c", commands[key].command],
                null, // envp
                GLib.SpawnFlags.DEFAULT, // flags
                null // GLib.SpawnChildSetupFunc
            );
        }
    }

    /**
     * Remote Methods
     */
    request() {
        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { requestCommandList: true }
        });
    }

    /**
     * Run the remote command @key
     * @param {string} key - The key of the remote command
     */
    run(key) {
        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { key: key }
        });
    }
});

