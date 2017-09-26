"use strict";

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const GSettingsWidget = Me.imports.widgets.gsettings;
const KeybindingsWidget = Me.imports.widgets.keybindings;
const PluginsWidget = Me.imports.widgets.plugins;
const Client = Me.imports.client;
const Config = Me.imports.service.config;
const { initTranslations, Resources, Settings, Schema } = Me.imports.common;


/** Gtk.Button subclass for launching dialogs or external programs */
var CallbackButton = new Lang.Class({
    Name: "CallbackButton",
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


/** A composite widget resembling A Gnome Control Center panel. */
var PrefsPage = new Lang.Class({
    Name: "PrefsPage",
    Extends: Gtk.ScrolledWindow,
    
    _init: function (params={}) {
        params = Object.assign({
            height_request: 400,
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
    addRow: function (section) {
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
        let key = Schema.get_key(keyName);
        let range = key.get_range().deep_unpack()[0];
        let type = key.get_value_type().dup_string();
        type = (range !== "type") ? range : type;
        
        if (widget !== undefined) {
            widget = new widget(Settings, keyName);
        } else if (type === "b") {
            widget = new GSettingsWidget.BoolSetting(Settings, keyName);
        } else if (type === "enum") {
            widget = new GSettingsWidget.EnumSetting(Settings, keyName);
        } else if (type === "flags") {
            widget = new GSettingsWidget.FlagsSetting(Settings, keyName);
        } else if (type === "mb") {
            widget = new GSettingsWidget.MaybeSetting(Settings, keyName);
        } else if (type.length === 1 && "ynqiuxthd".indexOf(type) > -1) {
            widget = new GSettingsWidget.NumberSetting(Settings, keyName, type);
        } else if (type === "range") {
            widget = new GSettingsWidget.RangeSetting(Settings, keyName);
        } else if (type.length === 1 && "sog".indexOf(type) > -1) {
            widget = new GSettingsWidget.StringSetting(Settings, keyName);
        } else {
            widget = new GSettingsWidget.OtherSetting(Settings, keyName);
        }
        
        return this.addItem(
            section,
            key.get_summary(),
            key.get_description(),
            widget
        );
    }
});


/**
 * Plugin stuff FIXME: move to discrete file?
 */
var DevicesPage = new Lang.Class({
    Name: "DevicesPage",
    Extends: Gtk.Grid,
    
    _init: function (params={}) {
        this.parent({
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        
        this.sidebar = new Gtk.ListBox();
        
        let sidebarScrolledWindow = new Gtk.ScrolledWindow({
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        sidebarScrolledWindow.add(this.sidebar);
        
        this.attach(sidebarScrolledWindow, 0, 0, 1, 1);
        this.attach(this.stack, 1, 0, 1, 1);
    },
    
    add_device: function (device) {
        // Device Sidebar Entry
        let row = new Gtk.ListBoxRow({
            visible: true,
            can_focus: true
        });
        row.device = device;
        
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
        
        let icon = Gtk.Image.new_from_icon_name(device.type, Gtk.IconSize.LARGE_TOOLBAR);
        row.grid.attach(icon, 0, 0, 1, 2);
        let nameLabel = new Gtk.Label({ label: device.name });
        row.grid.attach(nameLabel, 1, 0, 1, 1);
        let statusLabel = new Gtk.Label({ label: device.type });
        row.grid.attach(statusLabel, 1, 1, 1, 1);
        statusLabel.get_style_context().add_class("dim-label");
        this.sidebar.add(row);
        
        this.sidebar.connect("row-selected", (listbox, row) => {
            this.stack.set_visible_child_name(row.device.id);
        });
        
        // Device Page
        let page = new DevicePage(device);
        this.stack.add_titled(page, device.id, device.name);
        
        row.show_all();
    }
});


var DevicePage = new Lang.Class({
    Name: "DevicePage",
    Extends: PrefsPage,
    
    _init: function (device, params={}) {
        this.parent(params);
        this.box.margin_left = 40;
        this.box.margin_right = 40;
        
        this.device = device;
        this._config = Config.read_device_config(device.id);
        
        // Plugins
        let pluginsSection = this.add_section(_("Plugins"));
        
        for (let [pluginName, pluginInfo] of PluginsWidget.PluginMetadata.entries()) {
            let pluginWidget = new PluginsWidget.PluginSetting(this, pluginName);
            
            this.add_item(
                pluginsSection,
                pluginInfo.summary,
                pluginInfo.description,
                pluginWidget
            );
        }
        
        // Keybdinings
        // TODO: fix widget
        let keySection = this.add_section(_("Keyboard Shortcuts"));
        
        this.show_all();
    },
    
    _refresh: function () {
        this._config = Config.read_device_config(this.device.id);
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
        this.manager = false;
        
        this.switcher = new Gtk.StackSwitcher({
            halign: Gtk.Align.CENTER,
            stack: this
        });
        this.switcher.show_all();
        
        this._build();
        
        // Watch for Service Provider
        this.manager = new Client.DeviceManager();
        
        for (let device of this.manager.devices.values()) {
            this.devicesWidget.add_device(device);
        }
    },
    
    add_page: function (id, title) {
        let page = new PrefsPage();
        this.add_titled(page, id, title);
        return page;
    },
    
    remove_page: function (id) {
        throw Error("Not implemented, use PrefsWidget.remove(" + id + ")")
    },
    
    _build: function () {
        // General Page
        let generalPage = this.add_page("general", _("General"));
        
        let appearanceSection = generalPage.add_section(_("Appearance"));
        generalPage.add_setting(appearanceSection, "device-indicators");
        generalPage.add_setting(appearanceSection, "device-visibility");
        
        let filesSection = generalPage.add_section(_("Files"));
        generalPage.add_setting(filesSection, "device-automount");
        generalPage.add_setting(filesSection, "nautilus-integration");
        
        // FIXME
        //let keySection = generalPage.add_section(_("Keyboard Shortcuts"));
        //let keyRow = new KeybindingsWidget.KeybindingWidget();
        //keySection.list.add(keyRow);
        
        // Devices Page
        this.devicesWidget = new DevicesPage();
        let devicesPage = this.add_titled(this.devicesWidget, "devices", _("Devices"));
        
        // Service Page
        let servicePage = this.add_page("service", _("Service"));
        let serviceSection = servicePage.add_section(_("Service"));
        servicePage.add_setting(serviceSection, "persistent-discovery");
        
        // About/Advanced
        let advancedPage = this.add_page("advanced", _("Advanced"));
        let develSection = advancedPage.add_section(_("Development"));
        advancedPage.add_setting(develSection, "debug");
    }
});


function init() {
    initTranslations();
}

// Extension Preferences
function buildPrefsWidget() {
    let prefsWidget = new PrefsWidget();
    
    // HeaderBar
    Mainloop.timeout_add(0, () => {
        let headerBar = prefsWidget.get_toplevel().get_titlebar();
        headerBar.custom_title = prefsWidget.switcher;
        return false;
    });
    
    prefsWidget.show_all();
    return prefsWidget;
}

