"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
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
                    "emblem-system-symbolic",
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
        
        // InfoBar
        this.deleted = null;
        
        this.infobar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.INFO,
            show_close_button: true
        });
        this.infobar.get_content_area().add(
            new Gtk.Image({ icon_name: "user-trash-symbolic" })
        );
        this.infobar.label = new Gtk.Label({ label: "", use_markup: true });
        this.infobar.get_content_area().add(this.infobar.label);
        // TRANSLATORS: Undo device removal
        this.infobar.add_button(_("Undo"), 1);
        
        this.infobar.connect("response", (widget, response) => {
            if (response === 1 && this.deleted !== null) {
                this.deleted[0].move(
                    this.deleted[1],
                    Gio.FileCopyFlags.NONE,
                    null,
                    null
                );
            }
            
            this.deleted = null;
            this.infobar.hide();
            this.remove(this.infobar);
        });
        
        // Page Switcher
        this.sidebar = new Gtk.ListBox();
        
        let sidebarScrolledWindow = new Gtk.ScrolledWindow({
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        sidebarScrolledWindow.add(this.sidebar);
        
        this.attach(sidebarScrolledWindow, 0, 1, 1, 1);
        
        // Page Stack
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        this.attach(this.stack, 1, 1, 1, 1);
        
        // Default Page
        let page = new Gtk.Box({
            visible: true,
            can_focus: true,
            margin_left: 24,
            margin_top: 24,
            margin_bottom: 24,
            margin_right: 24,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            orientation: Gtk.Orientation.VERTICAL
        });
        
        let defaultPageLabel = new Gtk.Label({
            label: _("Ensure that devices are connected on the same local network and ports 1716 to 1764 are open for TCP and UDP connections.\n\n") +
                   _("To connect an Android device, install the KDE Connect Android app from the <a href=\"https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp\">Google Play Store</a> or <a href=\"https://f-droid.org/repository/browse/?fdid=org.kde.kdeconnect_tp\">F-Droid</a>.\n\n") +
                   _("Please see the <a href=\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki\">Wiki</a> for help or <a href =\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues\">open an issue</a> on Github to report a problem."),
            wrap: true,
            use_markup: true,
            vexpand: true,
            xalign: 0
        });
        page.add(defaultPageLabel);
        
        this.stack.add_titled(page, "default", "Default");
        
        this.sidebar.connect("row-selected", (listbox, row) => {
            if (row === null) {
                this.stack.set_visible_child_name("default");
            } else {
                this.stack.set_visible_child_name(row.device.id);
            }
        });
    },
    
    addDevice: function (daemon, dbusPath) {
        let device = daemon.devices.get(dbusPath);
        
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
        
        let metadata = DeviceType.get(device.type);
        
        let icon = Gtk.Image.new_from_icon_name(
            metadata.icon,
            Gtk.IconSize.LARGE_TOOLBAR
        );
        row.grid.attach(icon, 0, 0, 1, 1);
        let nameLabel = new Gtk.Label({ label: device.name });
        row.grid.attach(nameLabel, 1, 0, 1, 1);
        this.sidebar.add(row);
        
        row.show_all();
        
        // Device Page
        let page = new Page(daemon, device, this);
        this.stack.add_titled(page, device.id, device.name);
        
        // Tracking
        this.devices.set(dbusPath, [row, page]);
    },
    
    removeDevice: function (daemon, dbusPath) {
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
    
    _init: function (daemon, device, stack) {
        this.parent();
        this.box.margin_left = 36;
        this.box.margin_right = 36;
        
        this.stack = stack;
        
        this.daemon = daemon;
        this.device = device;
        this.config = Common.readDeviceConfiguration(device.id);
        
        // Info Section
        let metadata = DeviceType.get(device.type);
        
        let infoSection = this.addSection();
        let statusRow = this.addRow(infoSection);
        
        // Info Section // Type Icon
        let typeIcon = Gtk.Image.new_from_icon_name(
            metadata.icon,
            Gtk.IconSize.DIALOG
        );
        typeIcon.xalign = 0;
        statusRow.grid.attach(typeIcon, 0, 0, 1, 2);
        
        // Info Section // Name and Type Labels
        let nameLabel = new Gtk.Label({
            label: device.name,
            hexpand: true,
            xalign: 0,
            yalign: 0.75
        });
        statusRow.grid.attach(nameLabel, 1, 0, 1, 1);
        let typeLabel = new Gtk.Label({
            label: metadata.type,
            hexpand: true,
            xalign: 0,
            yalign: 0.25
        });
        typeLabel.get_style_context().add_class("dim-label");
        statusRow.grid.attach(typeLabel, 1, 1, 1, 1);
        
        let deviceControls = new Gtk.ButtonBox({
            halign: Gtk.Align.END,
            hexpand: true,
            spacing: 12
        });
        
        // Info Section // State Button (Pair/Unpair/Connect)
        let stateButton = new Gtk.Button({
            image: Gtk.Image.new_from_icon_name(
                "view-refresh-symbolic", // FIXME
                Gtk.IconSize.BUTTON
            ),
            always_show_image: true,
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        stateButton.get_style_context().add_class("circular");
        stateButton.connect("clicked", () => {
            if (this.device.connected && this.device.paired) {
                this.device.unpair();
            } else if (this.device.connected && !this.device.paired) {
                this.device.pair();
            } else {
                this.device.activate();
            }
        });
        this.device.connect("notify", () => {
            if (this.device.connected && this.device.paired) {
                stateButton.image = Gtk.Image.new_from_icon_name(
                    "channel-secure-symbolic", // FIXME
                    Gtk.IconSize.BUTTON
                );
                stateButton.set_tooltip_markup(
                    // TRANSLATORS: eg. Unpair <b>Google Pixel</b> Smartphone
                    _("Unpair <b>%s</b> %s").format(this.device.name, metadata.type)
                );
            } else if (this.device.connected && !this.device.paired) {
                stateButton.image = Gtk.Image.new_from_icon_name(
                    "channel-insecure-symbolic", // FIXME
                    Gtk.IconSize.BUTTON
                );
                stateButton.set_tooltip_markup(
                    // TRANSLATORS: Request pairing with a device. Goes on top of a "fingerprint" string
                    // PLEASE KEEP NEWLINE CHARACTERS (\n)
                    _("Request Pair\n\n") +
                    // TRANSLATORS: Remote and local TLS Certificate fingerprint
                    // PLEASE KEEP NEWLINE CHARACTERS (\n)
                    //
                    // Example:
                    //
                    // <b>Google Pixel Fingerprint:</b>
                    // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                    //
                    // <b>Local Fingerprint:</b>
                    // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                    _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.name, this.device.fingerprint, this.daemon.fingerprint)
                );
            } else {
                stateButton.image = Gtk.Image.new_from_icon_name(
                    "view-refresh-symbolic", // FIXME
                    Gtk.IconSize.BUTTON
                );
                stateButton.set_tooltip_markup(_("Attempt Reconnection"));
            }
        });
        this.device.notify("paired");
        statusRow.grid.attach(stateButton, 2, 0, 1, 2);
        
        // Info Section // Remove Button
        let removeButton = new Gtk.Button({
            image: Gtk.Image.new_from_icon_name(
                "user-trash-symbolic",
                Gtk.IconSize.BUTTON
            ),
            // TRANSLATORS: eg. Remove <b>Google Pixel</b> Smartphone
            tooltip_markup: _("Remove <b>%s</b> %s").format(
                this.device.name,
                metadata.type
            ),
            always_show_image: true,
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        removeButton.get_style_context().add_class("circular");
        
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        removeButton.connect("clicked", () => {
            // Watch trash so we can catch the dir
            let trash = Gio.File.new_for_uri("trash://")
            let monitor = trash.monitor_directory(0, null);
            let deviceDir = Gio.File.new_for_path(
                Common.CONFIG_PATH + "/" + this.device.id
            );
            
            monitor.connect("changed", (monitor, trashedDir, event_type) => {
                let info = trashedDir.query_info("trash::orig-path", 0, null);
                let path = info.get_attribute_byte_string("trash::orig-path");
                
                if (path === deviceDir.get_path()) {
                    this.stack.deleted = [trashedDir, deviceDir];
                    monitor.cancel();
                }
            });
            
            deviceDir.trash(null);
            
            // EAFP!
            this.stack.infobar.label.set_label(
                // TRANSLATORS: Shown in an InfoBar after a device is removed
                // eg. Removed <b>Google Pixel</b> and its configuration
                _("Removed <b>%s</b> and its configuration").format(this.device.name)
            );
            this.stack.attach(this.stack.infobar, 0, 0, 2, 1);
            this.stack.infobar.show_all();
        });
        statusRow.grid.attach(removeButton, 3, 0, 1, 2);
        
        // Plugins
        let pluginsSection = this.addSection(_("Plugins"));
        
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
        // TRANSLATORS: Open the device menu
        keyView.addAccel("menu", _("Open Menu"), 0, 0);
        // TRANSLATORS: Open a new SMS window
        keyView.addAccel("sms", _("Send SMS"), 0, 0);
        // TRANSLATORS: eg. Locate Google Pixel
        keyView.addAccel("find", _("Locate %s").format(this.device.name), 0, 0);
        // TRANSLATORS: Open the device's list of browseable directories
        keyView.addAccel("browse", _("Browse Files"), 0, 0);
        // TRANSLATORS: Open the file chooser for sending files/links
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
    },
    
    _refresh: function () {
        this.config = Common.readDeviceConfiguration(this.device.id);
    }
});


var DeviceType = new Map([
    ["desktop", {
        type: _("Desktop"),
        icon: "computer",
        symbolic_icon: "computer-symbolic"
    }],
    ["laptop", {
        type: _("Laptop"),
        icon: "computer",
        symbolic_icon: "laptop-symbolic"
    }],
    ["phone", {
        type: _("Smartphone"),
        icon: "phone",
        symbolic_icon: "smartphone-symbolic"
    }],
    ["tablet", {
        type: _("Tablet"),
        icon: "tablet",
        symbolic_icon: "tablet-symbolic"
    }],
    ["unknown", {
        type: _("Unknown"),
        icon: "computer",
        symbolic_icon: "computer-symbolic"
    }]
]);

