"use strict";

const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const GSettingsWidget = imports.widgets.gsettings;


/**
 * Convenience classes for widgets similar to Gnome Control Center
 */
var Row = new Lang.Class({
    Name: "GSConnectPreferencesRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params={}) {
        params = Object.assign({
            activatable: false,
            can_focus: false,
            selectable: false,
            height_request: 48,
            margin_left: 12,
            margin_top: 8,
            margin_bottom: 8,
            margin_right: 12,
        }, params);

        this.parent({
            can_focus: params.can_focus,
            activatable: params.activatable,
            selectable: params.selectable,
            height_request: params.height_request
        });

        this.grid = new Gtk.Grid({
            can_focus: false,
            column_spacing: 12,
            margin_left: params.margin_left,
            margin_top: params.margin_top,
            margin_bottom: params.margin_bottom,
            margin_right: params.margin_right,
            vexpand: true,
            valign: Gtk.Align.FILL
        });
        this.add(this.grid);
    }
});


var Setting = new Lang.Class({
    Name: "GSConnectPreferencesSetting",
    Extends: Row,

    _init: function (summary, description, widget) {
        this.parent({ height_request: 56 });

        this.summary = new Gtk.Label({
            can_focus: false,
            xalign: 0,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            label: summary,
            use_markup: true
        });
        this.grid.attach(this.summary, 0, 0, 1, 1);

        if (description) {
            this.description = new Gtk.Label({
                xalign: 0,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                label: description,
                use_markup: true,
                wrap: true
            });
            this.description.get_style_context().add_class("dim-label");
            this.grid.attach(this.description, 0, 1, 1, 1);
        }

        this.widget = widget;
        this.grid.attach(this.widget, 1, 0, 1, (description) ? 2 : 1);
    }
});


var Section = new Lang.Class({
    Name: "GSConnectPreferencesSection",
    Extends: Gtk.Frame,

    _init: function (params={}) {
        params = Object.assign({
            width_request: 460,
            selection_mode: Gtk.SelectionMode.NONE,
            margin_bottom: 32
        }, params);

        this.parent({
            can_focus: false,
            margin_bottom: params.margin_bottom,
            hexpand: true,
            shadow_type: Gtk.ShadowType.IN
        });

        this.list = new Gtk.ListBox({
            can_focus: false,
            hexpand: true,
            activate_on_single_click: true,
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
    },

    /**
     * Add and return new row with a Gtk.Grid child
     *
     * @param {Gtk.ListBoxRow|Row} [row] - The row to add, null to create new
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addRow: function (row, params={}) {
        if (!row) { row = new Row(params);}
        this.list.add(row);
        return row;
    },

    /**
     * Add a new row to @section and return the row. @summary will be placed on
     * top of @description (dimmed) on the left, @widget to the right of them.
     *
     * @param {String} summary - A short summary for the item
     * @param {String} description - A short description for the item
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addSetting: function (summary, description, widget) {
        let setting = new Setting(summary, description, widget);
        let row = this.addRow(setting);
        return row;
    },

    /**
     * Add a new row to @section, populated from the Schema for @settings and
     * the key @keyName. A Gtk.Widget will be chosen for @keyName based on it's
     * type, unless @widget is given which will have @settings and @keyName
     * passed to its constructor.
     *
     * @param {String} keyName - The GSettings key name
     * @param {Gtk.Widget} widget - An override widget
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addGSetting: function (settings, keyName, widget) {
        let key = settings.settings_schema.get_key(keyName);
        let range = key.get_range().deep_unpack()[0];
        let type = key.get_value_type().dup_string();
        type = (range !== "type") ? range : type;

        if (widget !== undefined) {
            widget = new widget(settings, keyName);
        } else if (type === "b") {
            widget = new GSettingsWidget.BoolSetting(settings, keyName);
        } else if (type === "enum") {
            widget = new GSettingsWidget.EnumSetting(settings, keyName);
        } else if (type === "flags") {
            widget = new GSettingsWidget.FlagsSetting(settings, keyName);
        } else if (type === "mb") {
            widget = new GSettingsWidget.MaybeSetting(settings, keyName);
        } else if (type.length === 1 && "ynqiuxthd".indexOf(type) > -1) {
            widget = new GSettingsWidget.NumberSetting(settings, keyName, type);
        } else if (type === "range") {
            widget = new GSettingsWidget.RangeSetting(settings, keyName);
        } else if (type.length === 1 && "sog".indexOf(type) > -1) {
            widget = new GSettingsWidget.StringSetting(settings, keyName);
        } else {
            widget = new GSettingsWidget.OtherSetting(settings, keyName);
        }

        return this.addSetting(
            key.get_summary(),
            key.get_description(),
            widget
        );
    }
});


/** A composite widget resembling A Gnome Control Center panel. */
var Page = new Lang.Class({
    Name: "GSConnectPreferencesPage",
    Extends: Gtk.ScrolledWindow,

    _init: function (params={}) {
        params = Object.assign({
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            valign: Gtk.Align.FILL,
            vexpand: true,
        }, params);
        this.parent(params);

        this.box = new Gtk.Box({
            can_focus: false,
            margin_left: 72,
            margin_right: 72,
            margin_top: 32,
            margin_bottom: 32,
            orientation: Gtk.Orientation.VERTICAL
        });
        this.add(this.box);
    },

    /**
     * Add and return a new section widget. If @title is given, a bold title
     * will be placed above the section.
     *
     * @param {string} [title] - Optional title for the section
     * @param {Section} [section] - The section to add, or null to create new
     * @return {Gtk.Frame} section - The new Section object.
     */
    addSection: function (title, section, params={}) {
        if (title) {
            let label = new Gtk.Label({
                can_focus: false,
                margin_bottom: 12,
                margin_start: 3,
                xalign: 0,
                use_markup: true,
                label: "<b>" + title + "</b>"
            });
            this.box.pack_start(label, false, true, 0);
        }

        if (!section) { section = new Section(params); }
        this.box.add(section);
        return section;
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

    addPage: function (id, title, params={}) {
        let page = new Page(params);
        this.add_titled(page, id, title);
        return page;
    },

    removePage: function (id) {
        let page = this.get_child_by_name(id);
        this.remove(page);
        page.destroy();
    }
});
