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
const GSettingsWidget = Me.imports.gsettingsWidget;
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


/** A composite widget resembling A Gnome Control Center panel. */
var PrefsPage = new Lang.Class({
    Name: "PrefsPage",
    Extends: Gtk.ScrolledWindow,
    
    _init: function (params={}) {
        params = Object.assign({
            height_request: 400,
            can_focus: true,
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
     * @param {String} keyName - The GSettings key name
     * @param {Gtk.Widget} widget - An override widget
     * @return {Gtk.ListBoxRow} row - The new row
     */
    add_setting: function (section, keyName, widget) {
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
        
        return this.add_item(
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
        
        for (let [pluginName, pluginInfo] of PluginMetadata.entries()) {
            let pluginWidget = new PluginSetting(this, pluginName);
            
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


/** Gtk widget for plugin enabling/disabling */
var PluginSetting = new Lang.Class({
    Name: "PluginSetting",
    Extends: Gtk.Box,
    
    _init: function (devicePage, pluginName) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12
        });
        
        this._page = devicePage;
        this._name = pluginName;
        this._info = PluginMetadata.get(this._name);
        this._freeze = false;
        
        if (this._info.hasOwnProperty("settings")) {
            this.settingButton = new CallbackButton({
                icon_name: "open-menu-symbolic",
                callback: Lang.bind(this, this._show_settings)
            });
            this.add(this.settingButton);
        }
        
        this.enableSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        this.enableSwitch.connect("notify::active", Lang.bind(this, this._toggle));
        this.add(this.enableSwitch);
        
        //
        this._refresh();
    },
    
    _refresh: function () {
        this._freeze = true;
        
        this.enableSwitch.active = this._page._config.plugins[this._name].enabled;
        
        this._freeze = false;
    },
    
    _toggle: function (widget) {
        if (this._freeze) { return; }
        
        let success;
        
        if (this.enableSwitch.active) {
            success = this._page.device.enablePlugin(this._name);
        } else {
            success = this._page.device.disablePlugin(this._name);
        }
        
        if (!success) {
            this._refresh();
            return;
        }
        
        this._page._refresh();
    },
    
    _show_settings: function () {
        let dialog = new this._info.settings(
            this._page,
            this._name,
            this._info,
            this.get_toplevel()
        );
        
        if (dialog.run() === Gtk.ResponseType.APPLY) {
            log("settings: " + JSON.stringify(dialog._settings));
            this._apply_settings(dialog._settings);
        }
        
        dialog.close();
    },
    
    _apply_settings: function (obj) {
        if (this._page.device.configurePlugin(this._name, obj)) {
            this._page._refresh();
        }
    }
});


var PluginDialog = new Lang.Class({
    Name: "PluginDialog",
    Extends: Gtk.Dialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent({
            title: _("FIXME pluginInfo"),
            use_header_bar: true,
            transient_for: win,
            default_height: 200,
            default_width: 200
        });
        
        let headerBar = this.get_header_bar();
        headerBar.title = pluginInfo.summary;
        headerBar.subtitle = pluginInfo.description;
        headerBar.show_close_button = false;
        
        this.add_button(_("Apply"), Gtk.ResponseType.APPLY);
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        
        this._page = devicePage;
        this._name = pluginName;
        this._info = pluginInfo;
        this._settings = {};
        
        this.content = new PrefsPage({
            height_request: -1,
            valign: Gtk.Align.FILL,
            vexpand: true
        });
        this.content.box.margin_left = 40;
        this.content.box.margin_right = 40;
        this.get_content_area().add(this.content);
    }
});


var BatteryPluginDialog = new Lang.Class({
    Name: "BatteryPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        this.section = this.content.add_section(_("Receiving"));
    }
});


var NotificationsPluginDialog = new Lang.Class({
    Name: "NotificationsPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        this.section = this.content.add_section(_("Receiving"));
    }
});


var RunCommandPluginDialog = new Lang.Class({
    Name: "RunCommandPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        this.section = this.content.add_section(_("Receiving"));
    }
});


var SharePluginDialog = new Lang.Class({
    Name: "SharePluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        let settings = this._page._config.plugins[this._name].settings;
        let receivingSection = this.content.add_section(_("Receiving"));
        
        let fbutton = new Gtk.FileChooserButton({
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        fbutton.set_current_folder(settings.download_directory);
        fbutton.connect("current-folder-changed", (button) => {
            this._settings.download_directory = fbutton.get_current_folder();
        });
        this.content.add_item(
            receivingSection,
            _("Download location"),
            _("Choose a location to save received files"),
            fbutton
        );
        
        let subdirsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.download_subdirs
        });
        subdirsSwitch.connect("notify::active", (widget) => {
            this._settings.download_subdirs = subdirsSwitch.active;
        });
        this.content.add_item(
            receivingSection,
            _("Subdirectories"),
            _("Save files in device subdirectories"),
            subdirsSwitch
        );
        
        this.content.show_all();
    }
});


var TelephonyPluginDialog = new Lang.Class({
    Name: "TelephonyPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        let settings = this._page._config.plugins[this._name].settings;
        
        // Phone Calls
        let callsSection = this.content.add_section(_("Phone Calls"));
        
        let notifyMissedCallSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.notify_missedCall
        });
        notifyMissedCallSwitch.connect("notify::active", (widget) => {
            this._settings.notify_missedCall = notifyMissedCallSwitch.active;
        });
        this.content.add_item(
            callsSection,
            _("Missed call notification"),
            _("Show a notification for missed calls"),
            notifyMissedCallSwitch
        );
        
        let notifyRingingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.notify_ringing
        });
        notifyRingingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_ringing = notifyRingingSwitch.active;
        });
        this.content.add_item(
            callsSection,
            _("Ringing notification"),
            _("Show a notification when the phone is ringing"),
            notifyRingingSwitch
        );
        
        let notifyTalkingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.notify_talking
        });
        notifyTalkingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_talking = notifyTalkingSwitch.active;
        });
        this.content.add_item(
            callsSection,
            _("Talking notification"),
            _("Show a notification when talking on the phone"),
            notifyTalkingSwitch
        );
        
        // SMS
        let smsSection = this.content.add_section(_("SMS"));
        
        let notifySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.notify_sms
        });
        notifySMSSwitch.connect("notify::active", (widget) => {
            this._settings.notify_sms = notifySMSSwitch.active;
        });
        this.content.add_item(
            smsSection,
            _("SMS notification"),
            _("Show a notification when an SMS is received"),
            notifySMSSwitch
        );
        
        let autoreplySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: settings.autoreply_sms
        });
        autoreplySMSSwitch.connect("notify::active", (widget) => {
            this._settings.autoreply_sms = autoreplySMSSwitch.active;
        });
        this.content.add_item(
            smsSection,
            _("Autoreply to SMS"),
            _("Open a new SMS window when an SMS is received"),
            autoreplySMSSwitch
        );
        
        this.content.show_all();
    }
});


var PluginMetadata = new Map([
    ["battery", {
        summary: _("Battery"),
        description: _("Monitor battery level and charging state"),
        settings: BatteryPluginDialog
    }],
    ["findmyphone", {
        summary: _("Find My Phone"),
        description: _("Locate device by ringing")
    }],
    ["notifications", {
        summary: _("Receive Notifications"),
        description: _("Receive notifications from other devices"),
        settings: NotificationsPluginDialog
    }],
    ["ping", {
        summary: _("Ping"),
        description: _("Send and receive pings")
    }],
    ["runcommand", {
        summary: _("Run Commands"),
        description: _("Run local commands from remote devices"),
        settings: RunCommandPluginDialog
    }],
    ["share", {
        summary: _("Share"),
        description: _("Send and receive files and URLs"),
        settings: SharePluginDialog
    }],
    ["telephony", {
        summary: _("Telephony"),
        description: _("Send and receive SMS and be notified of phone calls"),
        settings: TelephonyPluginDialog
    }]
]);


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
        
        let keySection = generalPage.add_section(_("Keyboard Shortcuts"));
        let keyRow = new KeybindingWidget();
        keySection.list.add(keyRow);
        
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

