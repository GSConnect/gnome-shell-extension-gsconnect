"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const GSettingsWidget = imports.widgets.gsettings;


/**
 * Convenience classes for widgets similar to Gnome Control Center
 *
 * TODO: https://bugzilla.gnome.org/show_bug.cgi?id=786384
 */


var Section = new Lang.Class({
    Name: "GSConnectPreferencesSection",
    Extends: Gtk.Frame,
    
    _init: function (params={}) {
        params = Object.assign({
            width_request: 460,
            selection_mode: Gtk.SelectionMode.NONE
        }, params);
    
        this.parent({
            visible: true,
            can_focus: false,
            margin_bottom: 32,
            hexpand: true,
            shadow_type: Gtk.ShadowType.IN
        });
        
        this.list = new Gtk.ListBox({
            visible: true,
            can_focus: false,
            hexpand: true,
            activate_on_single_click: false,
            selection_mode: params.selection_mode,
            width_request: params.width_request
        });
        this.add(this.list);
        
        this.list.set_header_func(this._header_func);
    },
    
    _header_func: function (row, before) {
        if (before) {
            row.set_header(
                new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL })
            );
        }
    }
});


var Row = new Lang.Class({
    Name: "GSConnectPreferencesRow",
    Extends: Gtk.ListBoxRow,
    
    _init: function (params={}) {
        params = Object.assign({
            height_request: 32
        }, params);
    
        this.parent({
            visible: true,
            can_focus: false,
            activatable: false,
            selectable: false,
            height_request: params.height_request
        });
        
        // Row Layout
        this.grid = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 12,
            row_spacing: 0,
            margin_left: 12,
            margin_top: 8,
            margin_bottom: 8,
            margin_right: 12,
            vexpand: true,
            valign: Gtk.Align.CENTER
        });
        this.add(this.grid);
    }
});


var Setting = new Lang.Class({
    Name: "GSConnectPreferencesSetting",
    Extends: Row,
    
    _init: function (summary, description, widget) {
        this.parent({ height_request: 40 });
        
        // Summary Label
        this.summary = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: summary,
        });
        this.grid.attach(this.summary, 0, 0, 1, 1);
        
        // Description Label
        if (description) {
            this.description = new Gtk.Label({
                visible: true,
                can_focus: false,
                xalign: 0,
                hexpand: true,
                label: description,
                wrap: true
            });
            this.description.get_style_context().add_class("dim-label");
            this.grid.attach(this.description, 0, 1, 1, 1);
        }
        
        // Control Widget
        this.widget = widget;
        this.grid.attach(this.widget, 1, 0, 1, (description) ? 2 : 1);
    }
});


/** A composite widget resembling A Gnome Control Center panel. */
var Page = new Lang.Class({
    Name: "GSConnectPreferencesPage",
    Extends: Gtk.ScrolledWindow,
    
    _init: function (params={}) {
        params = Object.assign({
            can_focus: true,
            visible: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        }, params);
        this.parent(params);
        
        this.box = new Gtk.Box({
            visible: true,
            can_focus: false,
            margin_left: 72,
            margin_right: 72,
            margin_top: 18,
            margin_bottom: 18,
            orientation: Gtk.Orientation.VERTICAL
        });
        this.add(this.box);
    },
    
    /**
     * Add and return a new section widget. If @title is given, a bold title
     * will be placed above the section.
     *
     * @param {String} title - Optional bold label placed above the section
     * @param {Gtk.ListBoxRow} [row] - The row to add, or null to create new
     * @return {Gtk.Frame} section - The new Section object.
     */
    addSection: function (title, section, params={}) {
        if (title) {
            let label = new Gtk.Label({
                visible: true,
                can_focus: false,
                margin_bottom: 12,
                xalign: 0,
                use_markup: true,
                label: "<b>" + title + "</b>"
            });
            this.box.pack_start(label, false, true, 0);
        }
        
        if (!section) { section = new Section(params); }
        this.box.add(section);
        return section;
    },
    
    /**
     * Add and return new row with a Gtk.Grid child
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @param {Gtk.ListBoxRow|Row} [row] - The row to add, null to create new
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addRow: function (section, row) {
        if (!row) { row = new Row();}
        section.list.add(row);
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
    addItem: function (section, summary, description, widget) {
        let setting = new Setting(summary, description, widget);
        let row = this.addRow(section, setting);
        return row;
    },
    
    /**
     * Add a new row to @section, populated from the Schema for @setting. An
     * Gtk.Widget will be chosen for @setting based on it's type, unless
     * @widget is given which will have @setting passed to it's constructor.
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @param {String} keyName - The GSettings key name
     * @param {Gtk.Widget} widget - An override widget
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addSetting: function (section, keyName, widget) {
        let key = Common.Settings.settings_schema.get_key(keyName);
        let range = key.get_range().deep_unpack()[0];
        let type = key.get_value_type().dup_string();
        type = (range !== "type") ? range : type;
        
        if (widget !== undefined) {
            widget = new widget(Common.Settings, keyName);
        } else if (type === "b") {
            widget = new GSettingsWidget.BoolSetting(Common.Settings, keyName);
        } else if (type === "enum") {
            widget = new GSettingsWidget.EnumSetting(Common.Settings, keyName);
        } else if (type === "flags") {
            widget = new GSettingsWidget.FlagsSetting(Common.Settings, keyName);
        } else if (type === "mb") {
            widget = new GSettingsWidget.MaybeSetting(Common.Settings, keyName);
        } else if (type.length === 1 && "ynqiuxthd".indexOf(type) > -1) {
            widget = new GSettingsWidget.NumberSetting(Common.Settings, keyName, type);
        } else if (type === "range") {
            widget = new GSettingsWidget.RangeSetting(Common.Settings, keyName);
        } else if (type.length === 1 && "sog".indexOf(type) > -1) {
            widget = new GSettingsWidget.StringSetting(Common.Settings, keyName);
        } else {
            widget = new GSettingsWidget.OtherSetting(Common.Settings, keyName);
        }
        
        return this.addItem(
            section,
            key.get_summary(),
            key.get_description(),
            widget
        );
    }
});


/** A GtkStack subclass with a pre-attached GtkStackSwitcher */
var Stack = new Lang.Class({
    Name: "GSConnectPreferencesStack",
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
    
    addPage: function (id, title) {
        let page = new Page();
        this.add_titled(page, id, title);
        return page;
    },
    
    removePage: function (id) {
        let page = this.get_child_by_name(id);
        this.remove(page);
        page.destroy();
    }
});
