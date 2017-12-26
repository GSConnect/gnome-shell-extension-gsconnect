"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/**
 * A Custom Gtk.TreeView for displaying and modifying keybinding profiles
 */
var TreeView = new Lang.Class({
    Name: "GSConnectKeybindingsTreeView",
    Extends: Gtk.TreeView,

    _init: function (settings, keyName) {
        this.parent({
            headers_visible: false,
            hexpand: true,
            activate_on_single_click: true
        });

        this.settings = settings;
        this.keyName = keyName;

        this.shellBus = new Gio.DBusProxy({
            gConnection: Gio.DBus.session,
            gName: "org.gnome.Shell",
            gObjectPath: "/org/gnome/Shell",
            gInterfaceName: "org.gnome.Shell"
        });

        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING,    // Description
            GObject.TYPE_INT,       // Key
            GObject.TYPE_INT        // Modifiers
        ]);
        this.model = listStore;

        // Description column
        let descCell = new Gtk.CellRendererText({ xpad: 6, ypad: 8 });
        let descCol = new Gtk.TreeViewColumn({ expand: true, clickable: false });
        descCol.pack_start(descCell, true);
        descCol.add_attribute(descCell, "text", 1);
        this.append_column(descCol);

        // Keybinding column
        this.accelCell = new Gtk.CellRendererAccel({
            accel_mode: Gtk.CellRendererAccelMode.GTK,
            editable: true,
            xalign: 1,
            xpad: 6,
            ypad: 8
        });

        let accelCol = new Gtk.TreeViewColumn();
        accelCol.pack_end(this.accelCell, false);
        accelCol.add_attribute(this.accelCell, "accel-key", 2);
        accelCol.add_attribute(this.accelCell, "accel-mods", 3);
        this.append_column(accelCol);

        //
        this.accelCell.connect("accel-edited", (renderer, path, key, mods) => {
            let [success, iter] = this.model.get_iter_from_string(path);

            if (success && mods > 0) {
                let name = this.model.get_value(iter, 0);
                let binding = Gtk.accelerator_name(key, mods);

                // Check for existing instance of binding
                if (this._check(binding)) {
                    let accels = this.getAccels();
                    accels[name] = binding;
                    this.setAccels(accels);

                    this.settings.set_string(
                        this.keyName,
                        JSON.stringify(this.getAccels())
                    );
                }
            }
        });

        this.accelCell.connect("accel-cleared", (renderer, path) => {
            let [success, iter] = this.model.get_iter_from_string(path);

            if (success) {
                this.model.set(iter, [2, 3], [0, 0]);

                this.settings.set_string(
                    this.keyName,
                    JSON.stringify(this.getAccels())
                );
            }
        });
    },

    /**
     * Add an accelerator to configure
     *
     * @param {string} name - a text id
     * @param {string} description - A description of the accelerator's purpose
     * @param {number} key - keyval
     * @param {number} mods - mod mask
     */
    addAccel: function (name, description, key, mods) {
        this.model.set(
            this.model.append(),
            [0, 1, 2, 3],
            [name, description, key, mods]
        );
    },

    getAccels: function () {
        let profile = {};

        this.model.foreach((model, path, iter, user_data) => {
            let name = model.get_value(iter, 0);
            let key = model.get_value(iter, 2);
            let mods = model.get_value(iter, 3);

            if (key === 0 || mods === 0) {
                profile[name] = "";
            } else {
                profile[name] = Gtk.accelerator_name(key, mods);
            }
        });

        return profile;
    },

    /**
     * Load a profile of keybindings
     *
     * @param {object} profile - An object with the structure:
     *
     *     { <accel-name>: <accel-string>, ... }
     */
    setAccels: function (profile) {
        this.model.foreach((model, path, iter, user_data) => {
            let name = model.get_value(iter, 0);

            if (profile.hasOwnProperty(name)) {
                model.set(iter, [2, 3], Gtk.accelerator_parse(profile[name]));
            }
        });
    },

    _check: function (binding) {
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
                secondary_text: _("The requested keyboard shortcut is already in use and can't be overridden.")
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

