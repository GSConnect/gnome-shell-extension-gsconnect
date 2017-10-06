"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

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
    addSection: function (title) {
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
    addRow: function (section) {
        // Row
        let row = new Gtk.ListBoxRow({
            visible: true,
            can_focus: false,
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
    addItem: function (section, summary, description, widget) {
        let row = this.addRow(section);
        
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
