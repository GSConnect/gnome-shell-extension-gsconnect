"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

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
    name: "runcommand",
    summary: _("Run Commands"),
    description: _("Execute local commands remotely"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Run-Commands-Plugin",
    incomingPackets: ["kdeconnect.runcommand.request"],
    outgoingPackets: ["kdeconnect.runcommand"],
    settings: {
        commands: {}
    }
};


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommand
 *
 * TODO: expose commands over DBus
 *       a PR for some new stuff was submitted
 */
var Plugin = new Lang.Class({
    Name: "GSConnectRunCommandPlugin",
    Extends: PluginsBase.Plugin,
    
    _init: function (device) {
        this.parent(device, "runcommand");
    },
    
    handlePacket: function (packet) {
        Common.debug("RunCommand: handlePacket()");
        
        if (packet.body.hasOwnProperty("requestCommandList")) {
            this.sendCommandList();
        } else if (packet.body.hasOwnProperty("key")) {
            if (this.settings.commands.hasOwnProperty(packet.body.key)) {
                GLib.spawn_async(
                    null, // working_dir
                    ["/bin/sh", "-c", this.settings.commands[packet.body.key].command],
                    null, // envp
                    GLib.SpawnFlags.DEFAULT, // flags
                    null // GLib.SpawnChildSetupFunc
                );
            }
        }
    },
    
    reconfigure: function () {
        Common.debug("RunCommand: reconfigure()");
        
        if (this.device.paired && this.device.connected) {
            this.sendCommandList();
        }
    },
    
    sendCommandList: function () {
        Common.debug("RunCommand: sendCommandList()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.runcommand",
            body: { commandList: JSON.stringify(this.settings.commands) }
        });
        
        this.device._channel.send(packet);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectRunCommandSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        let commandsSection = this.content.addSection(_("Commands"));
        // TreeView/Model
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true,
            margin_top: 6,
            height_request: 100
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // UUID
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING     // Command
        ]);
        this.treeview.model = listStore;
        
        // Name column.
        this.nameCell = new Gtk.CellRendererText({ editable: true });
        let nameCol = new Gtk.TreeViewColumn({
            title: _("Name"),
            expand: true
        });
        nameCol.pack_start(this.nameCell, true);
        nameCol.add_attribute(this.nameCell, "text", 1);
        this.treeview.append_column(nameCol);
        this.nameCell.connect("edited", Lang.bind(this, this._editName));
        
        // Command column.
        this.cmdCell = new Gtk.CellRendererText({ editable: true });
        let cmdCol = new Gtk.TreeViewColumn({
            // TRANSLATORS: A command to be executed remotely
            title: _("Command"),
            expand: true
        });
        cmdCol.pack_start(this.cmdCell, true);
        cmdCol.add_attribute(this.cmdCell, "text", 2);
        this.treeview.append_column(cmdCol);
        this.cmdCell.connect("edited", Lang.bind(this, this._editCmd));
        
        let commandRow = this.content.addRow(commandsSection);
        commandRow.grid.row_spacing = 12;
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        commandRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        // Buttons
        let buttonBox = new Gtk.ButtonBox({
            halign: Gtk.Align.END,
            spacing: 12
        });
        commandRow.grid.attach(buttonBox, 0, 1, 1, 1);
        
        let removeButton = new Gtk.Button({ label: _("Remove") });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);
        
        let addButton = new Gtk.Button({ label: _("Add") });
        addButton.connect("clicked", Lang.bind(this, this._add, false));
        buttonBox.add(addButton);
        
        this._populate();
        
        this.content.show_all();
    },
    
    _add: function (button, row) {
        if (row === false) {
            // TRANSLATORS: A placeholder for a new command name
            let commandName = _("[New command]")
            row = ["{" + GLib.uuid_string_random() + "}", commandName, ""];
            this.settings.commands[row[0]] = { name: row[1], command: row[2]};
        }
        
        this.treeview.model.set(this.treeview.model.append(), [0, 1, 2], row);
    },
    
    _remove: function (button) {
        //
        let [has, model, iter] = this.treeview.get_selection().get_selected();
        
        if (has) {
            let uuid = this.treeview.model.get_value(iter, 0);
            delete this.settings.commands[uuid];
            this.treeview.model.remove(iter);
        }
    },
    
    _editName: function (renderer, path, new_text, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            this.treeview.model.set_value(iter, 1, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this.settings.commands[uuid].name = new_text;
        }
    },
    
    _editCmd: function (renderer, path, new_text, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            this.treeview.model.set_value(iter, 2, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this.settings.commands[uuid].command = new_text;
        }
    },
    
    _populate: function () {
        for (let uuid in this.settings.commands) {
            this._add(null, [
                uuid,
                this.settings.commands[uuid].name,
                this.settings.commands[uuid].command
            ]);
        }
    }
});

