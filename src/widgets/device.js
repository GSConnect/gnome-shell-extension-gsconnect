"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const KeybindingsWidget = imports.widgets.keybindings;
const PreferencesWidget = imports.widgets.preferences;
const Common = imports.common;


/** Gtk widget for plugin enabling/disabling */
var PluginControl = new Lang.Class({
    Name: "GSConnectPluginControl",
    Extends: Gtk.Box,
    
    _init: function (page, name) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12
        });
        
        this._page = page;
        this._name = name;
        this._info = imports.service.plugins[this._name].METADATA; // FIXME
        this._freeze = false;
        
        if (this._info.hasOwnProperty("settings")) {
            let settingButton = new Gtk.Button({
                image: Gtk.Image.new_from_icon_name(
                    "open-menu-symbolic",
                    Gtk.IconSize.BUTTON
                ),
                visible: true,
                can_focus: true,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER
            });
            
            settingButton.get_style_context().add_class("circular");
            settingButton.connect("clicked", Lang.bind(this, this._configure));
            
            this.add(settingButton);
        }
        
        this.pluginSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        this.pluginSwitch.connect("notify::active", Lang.bind(this, this._toggle));
        this.add(this.pluginSwitch);
        
        //
        this._refresh();
    },
    
    _refresh: function () {
        this._freeze = true;
        
        this.pluginSwitch.active = this._page.config.plugins[this._name].enabled;
        
        this._freeze = false;
    },
    
    _toggle: function (widget) {
        if (!this._freeze) {
            let success;
            
            if (this.pluginSwitch.active) {
                success = this._page.device.enablePlugin(this._name);
            } else {
                success = this._page.device.disablePlugin(this._name);
            }
            
            if (!success) {
                this._refresh();
                return;
            }
            
            this._page._refresh();
        }
    },
    
    _configure: function () {
        let dialog = new imports.service.plugins[this._name].SettingsDialog(
            this._page,
            this._name,
            this._info,
            this.get_toplevel()
        );
        
        if (dialog.run() === Gtk.ResponseType.APPLY) {
            this._page.device.configurePlugin(this._name, dialog._settings);
            this._page._refresh();
        }
        
        dialog.close();
    }
});


var Stack = new Lang.Class({
    Name: "GSConnectDeviceStack",
    Extends: Gtk.Grid,
    
    _init: function () {
        this.parent({
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        
        this.devices = new Map();
        
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
        
        // Default Page
        let page = new Gtk.Box({
            visible: true,
            can_focus: true,
            margin_left: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_right: 12,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            orientation: Gtk.Orientation.VERTICAL
        });
        
        let label1 = new Gtk.Label({
            label: _("Ensure that devices are connected on the same local network with ports 1714 to 1764 open. If you wish to connect an Android device, install the KDE Connect Android app <a href=\"https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp\">Google Play Store</a> or <a href=\"https://f-droid.org/repository/browse/?fdid=org.kde.kdeconnect_tp\">F-Droid</a>."),
            wrap: true,
            use_markup: true,
            vexpand: true,
            xalign: 0
        });
        page.add(label1);
        //https://community.kde.org/KDEConnect
        let label2 = new Gtk.Label({
            label: _("If you are having trouble with this extension, please see the <a href=\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki\">Wiki</a> for help or <a href =\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues\">open an issue</a> on Github to report a problem."),
            wrap: true,
            use_markup: true,
            vexpand: true,
            xalign: 0
        });
        page.add(label2);
        
        this.stack.add_titled(page, "default", "Default");
        
        this.sidebar.connect("row-selected", (listbox, row) => {
            if (row === null) {
                this.stack.set_visible_child_name("default");
            } else {
                this.stack.set_visible_child_name(row.device.id);
            }
        });
    },
    
    addDevice: function (manager, dbusPath) {
        let device = manager.devices.get(dbusPath);
        
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
        
        row.show_all();
        
        // Device Page
        let page = new Page(device);
        this.stack.add_titled(page, device.id, device.name);
        
        // Tracking
        this.devices.set(dbusPath, [row, page]);
    },
    
    removeDevice: function (manager, dbusPath) {
        let device = this.devices.get(dbusPath);
        
        this.sidebar.remove(device[0]);
        device[0].destroy();
        
        this.stack.remove(device[1]);
        device[1].destroy();
        
        this.devices.delete(dbusPath);
    }
});


var Page = new Lang.Class({
    Name: "GSConnectDevicePage",
    Extends: PreferencesWidget.Page,
    
    _init: function (device) {
        this.parent();
        this.box.margin_left = 40;
        this.box.margin_right = 40;
        
        this.device = device;
        this.config = Common.readDeviceConfiguration(device.id);
        
        // Status
        // TODO: fingerprint
        //       remove device
        let statusSection = this.addSection();
        let statusRow = this.addRow(statusSection);
        
        let deviceIcon = Gtk.Image.new_from_icon_name(
            device.type,
            Gtk.IconSize.DIALOG
        );
        deviceIcon.xalign = 0;
        statusRow.grid.attach(deviceIcon, 0, 0, 1, 2);
        
        let deviceName = new Gtk.Label({ label: device.name, xalign: 0 });
        statusRow.grid.attach(deviceName, 1, 0, 1, 1);
        let deviceType = new Gtk.Label({ label: device.type, xalign: 0 });
        statusRow.grid.attach(deviceType, 1, 1, 1, 1);
        
        let deviceControls = new Gtk.ButtonBox({
            halign: Gtk.Align.END,
            hexpand: true,
            spacing: 12
        });
        statusRow.grid.attach(deviceControls, 2, 0, 1, 2);
        
        // Pair/Unpair Button
        let pairButton = new Gtk.Button({ label: "" });
        pairButton.connect("clicked", () => {
            if (this.device.paired) {
                this.device.unpair();
            } else {
                this.device.pair();
            }
        });
        this.device.connect("notify::paired", () => {
            if (this.device.paired) {
                pairButton.label = _("Unpair");
            } else {
                pairButton.label = _("Pair");
            }
        });
        this.device.notify("paired");
        this.device.bind_property(
            "connected",
            pairButton,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.device.notify("connected");  
        deviceControls.add(pairButton);
        
        // Plugins
        let pluginsSection = this.addSection(_("Plugins"));
        
        // FIXME: supported plugins property
        log("Name: " + this.device.name);
        log("Supported Plugins: " + this.device.supportedPlugins);
        for (let name of this.device.supportedPlugins) {
            let metadata = imports.service.plugins[name].METADATA;
            
            this.addItem(
                pluginsSection,
                metadata.summary,
                metadata.description,
                new PluginControl(this, name)
            );
        }
        
        // Keyboard Shortcuts
        let keySection = this.addSection(_("Keyboard Shortcuts"));
        let keyRow = this.addRow(keySection);
        let keyView = new KeybindingsWidget.TreeView();
        keyView.addAccel("menu", _("Open Device Menu"), 0, 0);
        keyView.addAccel("sms", _("Open SMS Window"), 0, 0);
        keyView.addAccel("find", _("Locate Device"), 0, 0);
        keyView.addAccel("browse", _("Browse Device"), 0, 0);
        keyView.addAccel("share", _("Share File/URL"), 0, 0);
        
        let deviceAccels = JSON.parse(
            Common.Settings.get_string("device-keybindings")
        );
        
        if (!deviceAccels.hasOwnProperty(this.device.id)) {
            deviceAccels[this.device.id] = {};
            Common.Settings.set_string(
                "device-keybindings",
                JSON.stringify(deviceAccels)
            );
        }
        
        keyView.setAccels(deviceAccels[this.device.id]);
        keyView.setCallback((profile) => {
            deviceAccels[this.device.id] = profile;
            Common.Settings.set_string(
                "device-keybindings",
                JSON.stringify(deviceAccels)
            );
        });
        keyRow.grid.attach(keyView, 0, 0, 1, 1);
        
        this.show_all();
        
        // Remove etc
        let deleteSection = this.addSection(_("Management"));
    },
    
    _refresh: function () {
        this.config = Common.readDeviceConfiguration(this.device.id);
    }
});

