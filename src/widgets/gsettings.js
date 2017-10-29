"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext; // FIXME

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/** A Gtk.Switch subclass for boolean GSettings. */
var BoolSetting = new Lang.Class({
    Name: "BoolSetting",
    Extends: Gtk.Switch,
    
    _init: function (settings, keyName) {
        this.parent({
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
    
        settings.bind(keyName, this, "active", Gio.SettingsBindFlags.DEFAULT);
    }
});

/** A Gtk.ComboBoxText subclass for GSetting choices and enumerations */
var EnumSetting = new Lang.Class({
    Name: "EnumSetting",
    Extends: Gtk.ComboBoxText,
    
    _init: function (settings, keyName) {
        this.parent({
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        let key = settings.settings_schema.get_key(keyName);
        let enums = key.get_range().deep_unpack()[1].deep_unpack();
        
        enums.forEach((enum_nick) => {
            this.append(enum_nick, _(enum_nick)); // TODO: better
        });
        
        this.active_id = settings.get_string(keyName);
        
        this.connect("changed", (widget) => {
            settings.set_string(keyName, widget.get_active_id());
        });
    }
});

/** A Gtk.MenuButton subclass for GSetting flags */
var FlagsSetting = new Lang.Class({
    Name: "FlagsSetting",
    Extends: Gtk.MenuButton,
    
    _init: function (settings, keyName, params={}) {
        if (!params.icon) {
            params.icon = new Gtk.Image({
                icon_name: "checkbox-checked-symbolic",
                icon_size: Gtk.IconSize.BUTTON
            });
        }
        
        this.parent({
            image: params.icon,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            popover: new Gtk.Popover()
        });
        this.get_style_context().add_class("circular");
        
        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 8
        });
        this.popover.add(this.box);
        
        let flag;
        let key = settings.settings_schema.get_key(keyName);
        let flags = key.get_range().deep_unpack()[1].deep_unpack();
        let old_flags = settings.get_value(keyName).deep_unpack();
        
        flags.forEach((flagNick) => {
            flag = new Gtk.CheckButton({
                label: _(flagNick),
                active: (old_flags.indexOf(flagNick) > -1)
            });
            
            flag.connect("toggled", (button) => {
                let new_flags = settings.get_value(keyName).deep_unpack();
                
                if (button.active) {
                    new_flags.push(flagNick);
                } else {
                    new_flags.splice(new_flags.indexOf(flagNick), 1);
                }
                
                settings.set_value(keyName, new GLib.Variant("as", new_flags));
            });
            
            this.box.add(flag);
        });
    }
});

/** A Gtk.Button/Popover subclass for GSetting nullable booleans (maybe) */
var MaybeSetting = new Lang.Class({
    Name: "MaybeSetting",
    Extends: Gtk.Button,
    
    _init: function (settings, keyName) {
        this.parent({
            can_focus: true,
            width_request: 120,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            margin_right: 12
        });
        
        this.popover = new Gtk.Popover({ relative_to: this });
        
        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 8
        });
        this.popover.add(this.box);
        
        let nothingButton = new Gtk.RadioButton({
            label: _("Nothing"),
            active: false
        });
        nothingButton.connect("toggled", (button) => {
            if (button.active) {
                settings.set_value(keyName, new GLib.Variant("mb", null));
                this.label = button.label;
            }
        });
        this.box.add(nothingButton);
        
        let trueButton = new Gtk.RadioButton({
            label: _("True")
        });
        trueButton.join_group(nothingButton);
        trueButton.connect("toggled", (button) => {
            if (button.active) {
                settings.set_value(keyName, new GLib.Variant("mb", true));
                this.label = button.label;
            }
        });
        this.box.add(trueButton);
        
        let falseButton = new Gtk.RadioButton({
            label: _("False")
        });
        falseButton.join_group(nothingButton);
        falseButton.connect("toggled", (button) => {
            if (button.active) {
                settings.set_value(keyName, new GLib.Variant("mb", false));
                this.label = button.label;
            }
        });
        this.box.add(falseButton);
        
        this.connect("clicked", () => { this.popover.show_all(); });
        
        let val = Settings.get_value(keyName).deep_unpack();
        
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
    
    _init: function (settings, keyName, type) {
        this.parent({
            climb_rate: 1.0,
            digits: (type === "d") ? 2 : 0,
            //snap_to_ticks: true,
            input_purpose: Gtk.InputPurpose.NUMBER,
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
    
        settings.bind(
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
    
    _init: function (settings, keyName) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: false,
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        let key = settings.settings_schema.get_key(keyName);
        let range = key.get_range().deep_unpack()[1].deep_unpack();
    
        this.adjustment = new Gtk.Adjustment({
            lower: range[0],
            upper: range[1],
            step_increment: 1
        });
    
        settings.bind(
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
    
    _init: function (settings, keyName) {
        this.parent({
            placeholder_text: settings.get_string(keyName),
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        
        this.connect("activate", (entry) => {
            settings.set_string(keyName, entry.text);
            entry.text = "";
            this.get_toplevel().set_focus(null);
        });
        
        this.connect("changed", (entry) => {
            if (entry.text.length) {
                entry.secondary_icon_name = "edit-undo-symbolic";
            } else {
                entry.text = "";
                entry.secondary_icon_name = "";
                this.get_toplevel().set_focus(null);
            }
        });
        
        this.connect("icon-release", (entry) => {
            entry.text = "";
            entry.secondary_icon_name = "";
            this.get_toplevel().set_focus(null);
        });
    
        settings.bind(
            keyName,
            this,
            "placeholder_text",
            Gio.SettingsBindFlags.DEFAULT
        );
    }
});

var FolderSetting = new Lang.Class({
    Name: "FolderSetting",
    Extends: Gtk.FileChooserButton,
    
    _init: function (settings, keyName) {
        this.parent({
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        
        this.set_filename(settings.get_string(keyName));
        this.connect("file-set", (button) => {
            settings.set_string(keyName, this.get_filename());
        });
    }
});

/** A Gtk.Entry subclass for all other GSettings */
var OtherSetting = new Lang.Class({
    Name: "OtherSetting",
    Extends: Gtk.Entry,
    
    _init: function (settings, keyName) {
        this.parent({
            text: settings.get_value(keyName).deep_unpack().toSource(),
            can_focus: true,
            width_request: 160,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            expand: true
        });
        
        this.keyName = keyName;
        this._type = settings.settings_schema.get_key(keyName).get_value_type().dup_string();

        settings.connect("changed::" + this._setting, () => {
            this.text = settings.get_value(keyName).deep_unpack().toSource();
        });
        
        this.connect("notify::text", (entry) => {
            let styleContext = entry.get_style_context();
            
            try {
                let variant = new GLib.Variant(entry._type, eval(entry.text));
                settings.set_value(entry._setting, variant);
                
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

