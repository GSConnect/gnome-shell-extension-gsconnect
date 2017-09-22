"use strict";

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain('gnome-shell-extension-gsconnect');
const _ = Gettext.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Client = Me.imports.client;
const Plugin = Me.imports.service.plugin;
const { initTranslations, Settings, Schema } = Me.imports.common;


/** A Gtk.Switch subclass for boolean GSettings. */
var BoolSetting = new Lang.Class({
    Name: "BoolSetting",
    Extends: Gtk.Switch,
    
    _init: function (setting) {
        this.parent({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
    
        Settings.bind(setting, this, "active", Gio.SettingsBindFlags.DEFAULT);
    }
});

/** A Gtk.ComboBoxText subclass for GSetting choices and enumerations */
var EnumSetting = new Lang.Class({
    Name: "EnumSetting",
    Extends: Gtk.ComboBoxText,
    
    _init: function (setting) {
        this.parent({
            visible: true,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        let key = Schema.get_key(setting);
        let enums = key.get_range().deep_unpack()[1].deep_unpack();
        
        enums.forEach((enum_nick) => {
            this.append(enum_nick, _(enum_nick)); // TODO: better
        });
        
        this.active_id = Settings.get_string(setting);
        
        this.connect("changed", (widget) => {
            Settings.set_string(setting, widget.get_active_id());
        });
    }
});

/** A Gtk.MenuButton subclass for GSetting flags */
var FlagsSetting = new Lang.Class({
    Name: "FlagsSetting",
    Extends: Gtk.MenuButton,
    
    _init: function (setting, params={}) {
        if (!params.icon) {
            params.icon = Gtk.Image.new_from_icon_name(
                "checkbox-checked-symbolic",
                Gtk.IconSize.BUTTON
            );
        }
        
        this.parent({
            image: params.icon,
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            popover: new Gtk.Popover()
        });
        this.get_style_context().add_class("circular");
        
        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            visible: true,
            margin: 8
        });
        this.popover.add(this.box);
        
        let flag;
        let key = Schema.get_key(setting);
        let flags = key.get_range().deep_unpack()[1].deep_unpack();
        let old_flags = Settings.get_value(setting).deep_unpack();
        
        flags.forEach((flagNick) => {
            flag = new Gtk.CheckButton({
                label: _(flagNick),
                visible: true,
                active: (old_flags.indexOf(flagNick) > -1)
            });
            
            flag.connect("toggled", (button) => {
                let new_flags = Settings.get_value(setting).deep_unpack();
                
                if (button.active) {
                    new_flags.push(flagNick);
                } else {
                    new_flags.splice(new_flags.indexOf(flagNick), 1);
                }
                
                Settings.set_value(setting, new GLib.Variant("as", new_flags));
            });
            
            this.box.add(flag);
        });
    }
});

/** A Gtk.Button/Popover subclass for GSetting nullable booleans (maybe) */
var MaybeSetting = new Lang.Class({
    Name: "MaybeSetting",
    Extends: Gtk.Button,
    
    _init: function (setting) {
        this.parent({
            visible: true,
            can_focus: true,
            width_request: 120,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            margin_right: 12
        });
        
        this.popover = new Gtk.Popover({ relative_to: this });
        
        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            visible: true,
            margin: 8
        });
        this.popover.add(this.box);
        
        let nothingButton = new Gtk.RadioButton({
            label: _("Nothing"),
            visible: true,
            active: false
        });
        nothingButton.connect("toggled", (button) => {
            if (button.active) {
                Settings.set_value(setting, new GLib.Variant("mb", null));
                this.label = button.label;
            }
        });
        this.box.add(nothingButton);
        
        let trueButton = new Gtk.RadioButton({
            label: _("True"),
            visible: true
        });
        trueButton.join_group(nothingButton);
        trueButton.connect("toggled", (button) => {
            if (button.active) {
                Settings.set_value(setting, new GLib.Variant("mb", true));
                this.label = button.label;
            }
        });
        this.box.add(trueButton);
        
        let falseButton = new Gtk.RadioButton({
            label: _("False"),
            visible: true
        });
        falseButton.join_group(nothingButton);
        falseButton.connect("toggled", (button) => {
            if (button.active) {
                Settings.set_value(setting, new GLib.Variant("mb", false));
                this.label = button.label;
            }
        });
        this.box.add(falseButton);
        
        this.connect("clicked", () => { this.popover.show_all(); });
        
        let val = Settings.get_value(setting).deep_unpack();
        
        if (val === true) {
            trueButton.active = true;
            this.label = trueButton.label;
        } else if (val === false) {
            falseButton.active = true;
            this.label = falseButton.label;
        } else {
            nothingButton.active = true;
            this.label = nothingButton.label;
        }
    }
});

/** A Gtk.SpinButton subclass for unranged integer GSettings */
var NumberSetting = new Lang.Class({
    Name: "NumberSetting",
    Extends: Gtk.SpinButton,
    
    _init: function (setting, type) {
        this.parent({
            climb_rate: 1.0,
            digits: (type === "d") ? 2 : 0,
            //snap_to_ticks: true,
            input_purpose: Gtk.InputPurpose.NUMBER,
            visible: true,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        
        let lower, upper;
        
        // FIXME: definitely not working
        if (type === "y") {
            [lower, upper] = [0, 255];
        } else if (type === "q") {
            [lower, upper] = [0, GLib.MAXUINT16];
        } else if (type === "i" || type === "h") {
            [lower, upper] = [GLib.MININT32, GLib.MAXINT32];
        } else if (type === "u") {
            [lower, upper] = [0, GLib.MAXUINT32];
        } else if (type === "x") {
            [lower, upper] = [GLib.MININT64, GLib.MAXINT64];
        } else if (type === "t") {
            [lower, upper] = [0, GLib.MAXUINT64];
        // TODO: not sure this is working
        } else if (type === "d") {
            [lower, upper] = [2.3E-308, 1.7E+308];
        } else if (type === "n") {
            [lower, upper] = [GLib.MININT16, GLib.MAXINT16];
        }
    
        this.adjustment = new Gtk.Adjustment({
            lower: lower,
            upper: upper,
            step_increment: 1
        });
    
        Settings.bind(
            setting,
            this.adjustment,
            "value",
            Gio.SettingsBindFlags.DEFAULT
        );
    }
});

/** A Gtk.Scale subclass for ranged integer GSettings */
var RangeSetting = new Lang.Class({
    Name: "RangeSetting",
    Extends: Gtk.Scale,
    
    _init: function (setting) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: false,
            visible: true,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        let key = Schema.get_key(setting);
        let range = key.get_range().deep_unpack()[1].deep_unpack();
    
        this.adjustment = new Gtk.Adjustment({
            lower: range[0],
            upper: range[1],
            step_increment: 1
        });
    
        Settings.bind(
            setting,
            this.adjustment,
            "value",
            Gio.SettingsBindFlags.DEFAULT
        );
    }
});

/** A Gtk.Entry subclass for string GSettings */
var StringSetting = new Lang.Class({
    Name: "StringSetting",
    Extends: Gtk.Entry,
    
    _init: function (setting) {
        this.parent({
            text: Settings.get_string(setting),
            visible: true,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
    
        Settings.bind(setting, this, "text", Gio.SettingsBindFlags.DEFAULT);
    }
});

/** A Gtk.Entry subclass for all other GSettings */
var OtherSetting = new Lang.Class({
    Name: "OtherSetting",
    Extends: Gtk.Entry,
    
    _init: function (setting) {
        this.parent({
            text: Settings.get_value(setting).deep_unpack().toSource(),
            visible: true,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        this._setting = setting;
        this._type = Schema.get_key(setting).get_value_type().dup_string();

        Settings.connect("changed::" + this._setting, () => {
            this.text = Settings.get_value(setting).deep_unpack().toSource();
        });
        
        this.connect("notify::text", (entry) => {
            let styleContext = entry.get_style_context();
            
            try {
                let variant = new GLib.Variant(entry._type, eval(entry.text));
                Settings.set_value(entry._setting, variant);
                
                if (styleContext.has_class("error")) {
                    styleContext.remove_class("error");
                }
            } catch (e) {
                if (!styleContext.has_class("error")) {
                    styleContext.add_class("error");
                }
            }
        });
    }
});


/** Gtk.Button subclass for launching dialogs or external programs */
var ButtonSetting = new Lang.Class({
    Name: "ButtonSetting",
    Extends: Gtk.Button,
    
    _init: function (params={}) {
        params = Object.assign({
            icon_name: "system-run-symbolic",
            callback: () => {}
        }, params);
        
        this.parent({
            image: Gtk.Image.new_from_icon_name(
                params.icon_name,
                Gtk.IconSize.BUTTON
            ),
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        
        this.get_style_context().add_class("circular");
        this.connect("clicked", params.callback);
    }
});


/**
 * A custom Gtk.ComboBox for selecting and initializing keybinding profiles for
 * devices.
 */
var KeybindingProfileBox = new Lang.Class({
    Name: "KeybindingProfileBox",
    Extends: Gtk.ComboBoxText,
    
    _init: function () {
        this.parent();
        
        this.manager = false;
        this.profiles = {};
        
        // Watch for Service Provider
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            Client.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );
        
        this.append("0", _("Select a device"));
        this._refresh();
    },
    
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        this.manager = new Client.DeviceManager();
        
        this.manager.connect("device::added", (manager, dbusPath) => {
            this._refresh();
        });
        
        this._refresh();
    },
    
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        if (this.manager) {
            this.manager.destroy();
            this.manager = false;
        }
    },
    
    _get_profiles: function () {
        this.profiles = Settings.get_value("device-keybindings").deep_unpack();
        
        for (let id in this.profiles) {
            this.profiles[id] = this.profiles[id].deep_unpack();
            this.profiles[id].name = this.profiles[id].name.deep_unpack();
            this.profiles[id].bindings = this.profiles[id].bindings.deep_unpack();
        }
        
        if (this.manager) {
            for (let device of this.manager.devices.values()) {
                // Add an empty keybinding profile for new devices
                if (!this.profiles.hasOwnProperty(device.id)) {
                    this.profiles[device.id] = {
                        name: device.name,
                        bindings: ["", "", "", "", "", ""]
                    };
                // Update device names for existing profiles
                } else {
                    this.profiles[device.id].name = device.name;
                }
            }
        }
        
        this._set_profiles();
    },
    
    _set_profiles: function () {
        let profiles = JSON.parse(JSON.stringify(this.profiles));
    
        for (let id in profiles) {
            profiles[id].name = new GLib.Variant("s", profiles[id].name);
            profiles[id].bindings = new GLib.Variant("as", profiles[id].bindings);
            profiles[id] = new GLib.Variant("a{sv}", profiles[id]);
        }
        
        Settings.set_value(
            "device-keybindings",
            new GLib.Variant("a{sv}", profiles)
        );
    },
    
    _refresh: function () {
        this._get_profiles();
        
        for (let id in this.profiles) {
            let found = false;
            
            if (id.length) {
                this.model.foreach((model, path, iter) => {
                    found = (model.get_value(iter, this.id_column) === id);
                    return found;
                });
                
                if (!found) {
                    this.append(id, this.profiles[id].name);
                }
            }
        }
    }
});


/**
 * A Custom Gtk.TreeView for displaying and modifying keybinding profiles
 */
var KeybindingView = new Lang.Class({
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
                let index = this.devView.model.get_value(iter, 0);
                this.extView.model.set(iter, [2, 3], [0, 0]);
                this._extKeys[index] = "";
                Settings.set_strv("extension-keybindings", this._extKeys);
            }
        });
        
        this._extKeys = Settings.get_strv("extension-keybindings");
        this.extView.load_profile(this._extKeys);
        
        // Device Keybindings
        let devSchema = Schema.get_key("device-keybindings");
        let devSummary = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: devSchema.get_summary()
        });
        this.grid.attach(devSummary, 0, 3, 1, 1);
        
        let devDesc = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: devSchema.get_description(),
            wrap: true
        });
        devDesc.get_style_context().add_class("dim-label");
        this.grid.attach(devDesc, 0, 4, 1, 1);
        
        this.keyBox = new KeybindingProfileBox();
        this.grid.attach(this.keyBox, 1, 3, 1, 2);
        
        this.devView = new KeybindingView();
        this.devView.add_accel(0, _("Open device menu"), 0, 0);
        this.devView.add_accel(1, _("Send SMS"), 0, 0);
        this.devView.add_accel(2, _("Locate Device"), 0, 0);
        this.devView.add_accel(3, _("Browse Files"), 0, 0);
        this.devView.add_accel(4, _("Send Files"), 0, 0);
        this.devView.add_accel(5, _("Pair/Reconnect"), 0, 0);
        this.grid.attach(this.devView, 0, 5, 2, 1);
        
        this.removeButton = new Gtk.Button({
            label: _("Remove"),
            tooltip_text: _("Remove the shortcuts for a defunct device."),
            halign: Gtk.Align.END
        });
        this.removeButton.get_style_context().add_class("destructive-action");
        this.removeButton.connect("clicked", () => {
            let old_id = new Number(this.keyBox.active.valueOf());
            delete this.keyBox.profiles[this.keyBox.active_id];
            this._devKeys = {};
            this.keyBox.active = 0;
            this.keyBox.remove(old_id);
            this.keyBox._set_profiles();
            this.keyBox._refresh();
        });
        this.grid.attach(this.removeButton, 1, 6, 1, 1);
        
        this.devView.accelCell.connect("accel-edited", (renderer, path, key, mods) => {
            let [success, iter] = this.devView.model.get_iter_from_string(path);
            
            if (success && mods > 0) {
                let index = this.devView.model.get_value(iter, 0);
                let binding = Gtk.accelerator_name(key, mods);
                
                // Check for existing instance of binding
                if (this._check(binding)) {
                    this._devKeys.bindings[index] = binding;
                    this.keyBox._set_profiles();
                    this.devView.load_profile(this._devKeys.bindings);
                }
            }
        });

        this.devView.accelCell.connect("accel-cleared", (renderer, path) => {
            let [success, iter] = this.devView.model.get_iter_from_string(path);
            
            if (success) {
                let index = this.devView.model.get_value(iter, 0);
                this.devView.model.set(iter, [2, 3], [0, 0]);
                this._devKeys.bindings[index] = "";
                this.keyBox._set_profiles();
            }
        });
        
        this.keyBox.connect("changed", (combobox, user_data) => {
            if (this.keyBox.active === 0) {
                this.devView.load_profile(undefined);
                this.devView.sensitive = false;
                this.removeButton.sensitive = false;
            } else {
                this._devKeys = this.keyBox.profiles[this.keyBox.active_id];
                this.devView.load_profile(this._devKeys.bindings);
                this.devView.sensitive = true;
                this.removeButton.sensitive = true;
            }
        });
        
        this.keyBox.active = 0;
    },
    
    _check: function (binding) {
        // Check we aren't already using the binding
        for (let id in this.keyBox.profiles) {
            let index = this.keyBox.profiles[id].bindings.indexOf(binding);
        
            if (index > -1) {
                this.keyBox.profiles[id].bindings[index] = "";
                this.keyBox._set_profiles();
                this.devView.load_profile(this._devKeys.bindings);
                return true;
            }
        }
        
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


/** A composite widget resembling A Gnome Control Center panel. */
var PrefsPage = new Lang.Class({
    Name: "PrefsPage",
    Extends: Gtk.ScrolledWindow,
    
    _init: function (params={}) {
        this.parent({
            height_request: 400,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        
        this.box = new Gtk.Box({
            visible: true,
            can_focus: false,
            margin_left: 80,
            margin_right: 80,
            margin_top: 18,
            margin_bottom: 18,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18
        });
        this.add(this.box);
    },
    
    /**
     * Add and return a new section widget. If @title is given, a bold title
     * will be placed above the section.
     *
     * @param {String} title - Optional bold label placed above the section
     * @return {Gtk.Frame} section - The new Section object.
     */
    add_section: function (title) {
        if (title) {
            let label = new Gtk.Label({
                visible: true,
                can_focus: false,
                margin_start: 3,
                xalign: 0,
                use_markup: true,
                label: "<b>" + title + "</b>"
            });
            this.box.pack_start(label, false, true, 0);
        }
        
        let section = new Gtk.Frame({
            visible: true,
            can_focus: false,
            margin_bottom: 12,
            hexpand: true,
            label_xalign: 0,
            shadow_type: Gtk.ShadowType.IN
        });
        this.box.add(section);
        
        section.list = new Gtk.ListBox({
            visible: true,
            can_focus: false,
            hexpand: true,
            selection_mode: Gtk.SelectionMode.NONE,
            activate_on_single_click: false
        });
        section.add(section.list);
        
        return section;
    },
    
    /**
     * Add and return new row with a Gtk.Grid child
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @return {Gtk.ListBoxRow} row - The new row
     */
    add_row: function (section) {
        // Row
        let row = new Gtk.ListBoxRow({
            visible: true,
            can_focus: true,
            activatable: false,
            selectable: false
        });
        section.list.add(row);
        
        // Row Layout
        row.grid = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 16,
            row_spacing: 0,
            margin_left: 12,
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12
        });
        row.add(row.grid);
        
        return row;
    },
    
    /**
     * Add a new row to @section and return the row. @summary will be placed on
     * top of @description (dimmed) on the left, @widget to the right of them. 
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @param {String} summary - A short summary for the item
     * @param {String} description - A short description for the item
     * @return {Gtk.ListBoxRow} row - The new row
     */
    add_item: function (section, summary, description, widget) {
        
        let row = this.add_row(section);
        
        // Setting Summary
        let summaryLabel = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: summary
        });
        row.grid.attach(summaryLabel, 0, 0, 1, 1);
        
        // Setting Description
        if (description !== undefined) {
            let descriptionLabel = new Gtk.Label({
                visible: true,
                can_focus: false,
                xalign: 0,
                hexpand: true,
                label: description,
                wrap: true
            });
            descriptionLabel.get_style_context().add_class("dim-label");
            row.grid.attach(descriptionLabel, 0, 1, 1, 1);
        }
        
        let widgetHeight = (description !== null) ? 2 : 1;
        row.grid.attach(widget, 1, 0, 1, widgetHeight);
        
        return row;
    },
    
    /**
     * Add a new row to @section, populated from the Schema for @setting. An
     * Gtk.Widget will be chosen for @setting based on it's type, unless
     * @widget is given which will have @setting passed to it's constructor.
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @param {String} setting - A short summary for the item
     * @param {Gtk.Widget} widget - A short description for the item
     * @return {Gtk.ListBoxRow} row - The new row
     */
    add_setting: function (section, setting, widget) {
        let key = Schema.get_key(setting);
        let range = key.get_range().deep_unpack()[0];
        let type = key.get_value_type().dup_string();
        type = (range !== "type") ? range : type;
        
        if (widget !== undefined) {
            widget = new widget(setting);
        } else if (type === "b") {
            widget = new BoolSetting(setting);
        } else if (type === "enum") {
            widget = new EnumSetting(setting);
        } else if (type === "flags") {
            widget = new FlagsSetting(setting);
        } else if (type === "mb") {
            widget = new MaybeSetting(setting);
        } else if (type.length === 1 && "ynqiuxthd".indexOf(type) > -1) {
            widget = new NumberSetting(setting, type);
        } else if (type === "range") {
            widget = new RangeSetting(setting);
        } else if (type.length === 1 && "sog".indexOf(type) > -1) {
            widget = new StringSetting(setting);
        } else {
            widget = new OtherSetting(setting);
        }
        
        return this.add_item(
            section,
            key.get_summary(),
            key.get_description(),
            widget
        );
    }
});


/** A GtkStack subclass with a pre-attached GtkStackSwitcher */
var PrefsWidget = new Lang.Class({
    Name: "PrefsWidget",
    Extends: Gtk.Stack,
    
    _init: function (params={}) {
        params = Object.assign({
            transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT
        }, params);
        
        this.parent(params);
        
        this.switcher = new Gtk.StackSwitcher({
            halign: Gtk.Align.CENTER,
            stack: this
        });
        this.switcher.show_all();
    },
    
    add_page: function (id, title) {
        let page = new PrefsPage();
        this.add_titled(page, id, title);
        return page;
    },
    
    remove_page: function (id) {
        throw Error("Not implemented, use PrefsWidget.remove(" + id + ")")
    }
});


function init() {
    initTranslations();
}

// Extension Preferences
function buildPrefsWidget() {
    let prefsWidget = new PrefsWidget();

    // Preferences Page
    let generalPage = prefsWidget.add_page("prefs", _("General"));
    
    let appearanceSection = generalPage.add_section(_("Appearance"));
    generalPage.add_setting(appearanceSection, "device-indicators");
    generalPage.add_setting(appearanceSection, "device-visibility");
    
    let filesSection = generalPage.add_section(_("Files"));
    generalPage.add_setting(filesSection, "device-automount");
    generalPage.add_setting(filesSection, "nautilus-integration");
    
    // Keyboard Shortcuts Page
    let keyPage = prefsWidget.add_page("kb", _("Keyboard"));
    
    let keySection = keyPage.add_section(_("Keyboard Shortcuts"));
    
    let keyRow = new KeybindingWidget();
    keySection.list.add(keyRow);
    
    // Advanced Page
    let advancedPage = prefsWidget.add_page("advanced", _("Advanced"));
    
    let serviceSection = advancedPage.add_section(_("Service"));
        // FIXME FIXME FIXME
//    advancedPage.add_setting(serviceSection, "service-autostart");
    advancedPage.add_setting(serviceSection, "persistent-discovery");
    
    let develSection = advancedPage.add_section(_("Development"));
    advancedPage.add_setting(develSection, "debug");
    
    // HeaderBar
    Mainloop.timeout_add(0, () => {
        let headerBar = prefsWidget.get_toplevel().get_titlebar();
        headerBar.custom_title = prefsWidget.switcher;
        return false;
    });
    
    prefsWidget.show_all();
    return prefsWidget;
}

