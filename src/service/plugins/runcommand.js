"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Run Commands"),
    description: _("Execute local commands remotely"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand",
    incomingPackets: ["kdeconnect.runcommand", "kdeconnect.runcommand.request"],
    outgoingPackets: ["kdeconnect.runcommand", "kdeconnect.runcommand.request"]
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
            "CommandList",
            "A string of JSON containing the remote commands",
            GObject.ParamFlags.READABLE,
            "{}"
        )
    },

    _init: function (device) {
        this.parent(device, "runcommand");

        this.settings.connect("changed::command-list", () => {
            this.send();
        });

        this._commands = "{}";
        this.notify("commands");
        this._dbus.emit_property_changed(
            "commands",
            new GLib.Variant("s", this._commands)
        );
        this.request();
    },

    get commands () {
        return this._commands;
    },

    handlePacket: function (packet) {
        debug("RunCommand: handlePacket()");

        if (packet.type === "kdeconnect.runcommand.request") {
            if (packet.body.hasOwnProperty("requestCommandList")) {
                this.send();
            } else if (packet.body.hasOwnProperty("key")) {
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
            }
        } else if (packet.type === "kdeconnect.runcommand") {
            this._commands = packet.body.commandList;
            this.notify("commands");
            this._dbus.emit_property_changed(
                "commands",
                new GLib.Variant("(s)", [this._commands])
            );
        }
    },

    /**
     * Request the list of remote commands
     */
    request: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { requestCommandList: true }
        });

        this.device._channel.send(packet);
    },

    /**
     * Run the remote command @key
     * @param {string} key - The key of the remote command
     */
    run: function (key) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.runcommand.request",
            body: { key: key }
        });

        this.device._channel.send(packet);
    },

    /**
     * Send the list of local command
     */
    send: function () {
        debug("RunCommand: sendCommandList()");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.runcommand",
            body: { commandList: this.settings.get_string("command-list") }
        });

        this.device._channel.send(packet);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectRunCommandSettingsDialog",
    Extends: PluginsBase.SettingsDialog,

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let commandsSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );

        // TreeView/Model
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true
        });

        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // UUID
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING     // Command
        ]);
        this.treeview.model = listStore;

        // Name column.
        let nameCell = new Gtk.CellRendererText({
            editable: true,
            xpad: 6,
            ypad: 6
        });
        let nameColumn = new Gtk.TreeViewColumn({
            // TRANSLATORS: Column header for RunCommand command list
            title: _("Name"),
            expand: true
        });
        nameColumn.pack_start(nameCell, true);
        nameColumn.add_attribute(nameCell, "text", 1);
        this.treeview.append_column(nameColumn);
        nameCell.connect("edited", Lang.bind(this, this._editName));

        // Command column.
        let commandCell = new Gtk.CellRendererText({
            editable: true,
            xpad: 6,
            ypad: 6
        });
        let commandColumn = new Gtk.TreeViewColumn({
            // TRANSLATORS: Column header for RunCommand command list
            title: _("Command"),
            expand: true
        });
        commandColumn.pack_start(commandCell, true);
        commandColumn.add_attribute(commandCell, "text", 2);
        this.treeview.append_column(commandColumn);
        commandCell.connect("edited", Lang.bind(this, this._editCommand));

        let commandRow = commandsSection.addRow();
        commandRow.grid.margin = 0;

        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 192,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        commandRow.grid.attach(treeScroll, 0, 0, 1, 1);

        // Buttons
        let buttonBox = new Gtk.Box({
            hexpand: true,
            halign: Gtk.Align.END,
            margin: 6
        });
        buttonBox.get_style_context().add_class("linked");
        commandRow.grid.attach(buttonBox, 0, 1, 1, 1);

        let removeButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "list-remove-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            hexpand: false
        });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);

        let addButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "list-add-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            hexpand: false
        });
        addButton.connect("clicked", Lang.bind(this, this._add));
        buttonBox.add(addButton);

        this._commands = JSON.parse(this.settings.get_string("command-list"));
        this._populate();

        this.content.show_all();
    },

    _add: function (button) {
        let row = ["{" + GLib.uuid_string_random() + "}", "", ""];
        this._commands[row[0]] = { name: row[1], command: row[2]};

        this.settings.set_string(
            "command-list",
            JSON.stringify(this._commands)
        );

        let iter = this.treeview.model.append();
        this.treeview.model.set(iter, [0, 1, 2], row);
        this.treeview.set_cursor(
            this.treeview.model.get_path(iter),
            this.treeview.get_column(0),
            true
        );
    },

    _remove: function (button) {
        let [has, model, iter] = this.treeview.get_selection().get_selected();

        if (has) {
            let uuid = this.treeview.model.get_value(iter, 0);
            delete this._commands[uuid];
            this.settings.set_string(
                "command-list",
                JSON.stringify(this._commands)
            );
            this.treeview.model.remove(iter);
        }
    },

    _populate: function () {
        for (let uuid in this._commands) {
            this.treeview.model.set(
                this.treeview.model.append(),
                [0, 1, 2],
                [uuid, this._commands[uuid].name, this._commands[uuid].command]
            );
        }
    },

    _editName: function (renderer, path, new_text) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);

        if (success) {
            this.treeview.model.set_value(iter, 1, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this._commands[uuid].name = new_text;
            this.settings.set_string(
                "command-list",
                JSON.stringify(this._commands)
            );
        }
    },

    _editCommand: function (renderer, path, new_text) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);

        if (success) {
            this.treeview.model.set_value(iter, 2, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this._commands[uuid].command = new_text;
            this.settings.set_string(
                "command-list",
                JSON.stringify(this._commands)
            );
        }
    }
});

