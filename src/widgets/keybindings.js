"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext; // FIXME

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/**
 * A Custom Gtk.TreeView for displaying and modifying keybinding profiles
 */
var TreeView = new Lang.Class({
    Name: "KeybindingView",
    Extends: Gtk.TreeView,
    
    _init: function () {
        this.parent({
            enable_grid_lines: true,
            headers_visible: false,
            hexpand: true,
            margin_top: 6
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_INT,       // Index
            GObject.TYPE_STRING,    // Action
            GObject.TYPE_INT,       // Key
            GObject.TYPE_INT        // Modifiers
        ]);
        this.model = listStore;

        // Description column.
        let descCell = new Gtk.CellRendererText({ xpad: 6, ypad: 12 });
        let descCol = new Gtk.TreeViewColumn({ expand: true, clickable: false });
        descCol.pack_start(descCell, true);
        descCol.add_attribute(descCell, "text", 1);
        this.append_column(descCol);

        // Key binding column.
        this.accelCell = new Gtk.CellRendererAccel({
            accel_mode: Gtk.CellRendererAccelMode.GTK,
            editable: true,
            xalign: 1,
            xpad: 6,
            ypad: 12
        });

        let accelCol = new Gtk.TreeViewColumn();
        accelCol.pack_end(this.accelCell, false);
        accelCol.add_attribute(this.accelCell, "accel-key", 2);
        accelCol.add_attribute(this.accelCell, "accel-mods", 3);
        this.append_column(accelCol);
    },
    
    /**
     * Load a profile of keybindings
     *
     * @param {Array} profile - The section widget to attach to
     */
    load_profile: function (profile) {
        if (profile === undefined) {
            this.model.foreach((model, path, iter, user_data) => {
                model.set(iter, [2, 3], [0, 0]);
            });
        } else {
            this.model.foreach((model, path, iter, user_data) => {
                let index = model.get_value(iter, 0);
                model.set(iter, [2, 3], Gtk.accelerator_parse(profile[index]));
            });
        }
    },
    
    /**
     *
     */
    add_accel: function (index, description, key, mods) {
        this.model.set(
            this.model.append(),
            [0, 1, 2, 3],
            [index, description, key, mods]
        );
    }
});


/** 
 * A composite widget that combines KeybindingProfileBox and KeybindingView
 * into a single settings panel for managing device keybinding profiles.
 */
var KeybindingWidget = new Lang.Class({
    Name: "KeybindingWidget",
    Extends: Gtk.ListBoxRow,
    
    _init: function () {
        this.parent({
            visible: true,
            can_focus: true,
            activatable: false,
            selectable: false
        });
        
        this.shellBus = new Gio.DBusProxy({
            gConnection: Gio.DBus.session,
            gName: "org.gnome.Shell",
            gObjectPath: "/org/gnome/Shell",
            gInterfaceName: "org.gnome.Shell"
        });
        
        this.grid = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 16,
            row_spacing: 6,
            margin_left: 12,
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12
        });
        this.add(this.grid);
        
        // Extension Keybindings
        let extSchema = Schema.get_key("extension-keybindings");
        let extSummary = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: extSchema.get_summary()
        });
        this.grid.attach(extSummary, 0, 0, 1, 1);
        
        let extDesc = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: extSchema.get_description(),
            wrap: true
        });
        extDesc.get_style_context().add_class("dim-label");
        this.grid.attach(extDesc, 0, 1, 1, 1);
        
        this.extView = new KeybindingView();
        this.extView.margin_bottom = 12;
        this.extView.add_accel(0, _("Open extension menu"), 0, 0);
        this.extView.add_accel(1, _("Discover Devices"), 0, 0);
        this.extView.add_accel(2, _("Open extension preferences"), 0, 0);
        this.extView.add_accel(3, _("Open service settings"), 0, 0);
        this.grid.attach(this.extView, 0, 2, 2, 1);
        
        this.extView.accelCell.connect("accel-edited", (renderer, path, key, mods) => {
            let [success, iter] = this.extView.model.get_iter_from_string(path);
            
            if (success && mods > 0) {
                let index = this.extView.model.get_value(iter, 0);
                let binding = Gtk.accelerator_name(key, mods);
                
                // Check for existing instance of binding
                if (this._check(binding)) {
                    this._extKeys[index] = binding;
                    Settings.set_strv("extension-keybindings", this._extKeys);
                    this.extView.load_profile(this._extKeys);
                }
            }
        });

        this.extView.accelCell.connect("accel-cleared", (renderer, path) => {
            let [success, iter] = this.extView.model.get_iter_from_string(path);
            
            if (success) {
                let index = this.extView.model.get_value(iter, 0);
                this.extView.model.set(iter, [2, 3], [0, 0]);
                this._extKeys[index] = "";
                Settings.set_strv("extension-keybindings", this._extKeys);
            }
        });
        
        this._extKeys = Settings.get_strv("extension-keybindings");
        this.extView.load_profile(this._extKeys);
    },
    
    _check: function (binding) {
        if (this._extKeys.indexOf(binding) > -1) {
            this._extKeys[this._extKeys.indexOf(binding)] = "";
            Settings.set_strv("extension-keybindings", this._extKeys);
            this.extView.load_profile(this._extKeys);
            return true;
        }
        
        // Check someone else isn't already using the binding
        let action = this.shellBus.call_sync(
            "GrabAccelerator",
            new GLib.Variant("(su)", [binding, 0]),
            0,
            -1,
            null
        ).deep_unpack()[0];
        
        if (action === 0) {
            let dialog = new Gtk.MessageDialog({
                message_type: Gtk.MessageType.WARNING,
                buttons: Gtk.ButtonsType.CLOSE,
                transient_for: this.get_toplevel(),
                text: _("Keyboard Shortcut Unavailable"),
                secondary_text: _("The requested keyboard shortcut is in use by another application and can't be overridden.")
            });
            
            dialog.run();
            dialog.close();
            return false;
        } else {
            this.shellBus.call_sync(
                "UngrabAccelerator",
                new GLib.Variant("(u)", [action]),
                0,
                -1,
                null
            );
            return true;
        }
    }
});



