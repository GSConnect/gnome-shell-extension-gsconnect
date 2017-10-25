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
    Extends: Gtk.Grid,
    
    _init: function (page, name) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            column_spacing: 12
        });
        
        this._page = page;
        this._name = name;
        this._freeze = false;
        let metadata = imports.service.plugins[this._name].METADATA;
        
        if (metadata.hasOwnProperty("settings")) {
            this.settingButton = new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: "emblem-system-symbolic",
                    icon_size: Gtk.IconSize.BUTTON
                }),
                always_show_image: true,
                can_focus: true,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER
            });
            
            this.settingButton.get_style_context().add_class("circular");
            this.settingButton.connect("clicked", Lang.bind(this, this._configure));
            
            this.attach(this.settingButton, 1, 0, 1, 1);
        }
        
        this.pluginSwitch = new Gtk.Switch({
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        this.pluginSwitch.connect("notify::active", Lang.bind(this, this._toggle));
        this.attach(this.pluginSwitch, 2, 0, 1, 1);
        
        this.errorImage = new Gtk.Image({
            icon_name: "dialog-warning",
            icon_size: Gtk.IconSize.LARGE_TOOLBAR,
            visible: true
        });
        
        this._refresh();
    },
    
    _refresh: function () {
        this._freeze = true;
        
        this.pluginSwitch.active = this._page.config.plugins[this._name].enabled;
        
        this._freeze = false;
    },
    
    _toggle: function (widget) {
        if (!this._freeze) {
            let result, success, error;
            
            if (this.pluginSwitch.active) {
                result = this._page.device.enablePlugin(this._name);
                success = result["0"];
                error = result["1"];
                
                if (!success) {
                    if (!this.get_child_at(0, 0)) {
                        this.attach(this.errorImage, 0, 0, 1, 1);
                    }
                    
                    this.errorImage.set_tooltip_markup(
                        _("Error: %s").format(error)
                    );
                    
                    this._refresh();
                    return;
                } else if (this.get_child_at(0, 0)) {
                    this.remove(this.errorImage);
                }
            } else {
                this._page.device.disablePlugin(this._name);
            }
            
            this._page._refresh();
        }
    },
    
    _configure: function () {
        let dialog = new imports.service.plugins[this._name].SettingsDialog(
            this._page,
            this._name,
            this.get_toplevel()
        );
        
        if (dialog.run() === Gtk.ResponseType.APPLY) {
            this._page.device.configurePlugin(this._name, dialog.settings);
        }
        
        this._page._refresh();
        dialog.close();
    }
});


var Stack = new Lang.Class({
    Name: "GSConnectDeviceStack",
    Extends: Gtk.Grid,
    
    _init: function (prefsWidget) {
        this.parent({
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        
        this._parent = prefsWidget;
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
        
        // Device Switcher
        this.sidebar = new Gtk.ListBox({ vexpand: true });
        let sidebarScrolledWindow = new Gtk.ScrolledWindow({
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        sidebarScrolledWindow.add(this.sidebar);
        
        this.attach(sidebarScrolledWindow, 0, 1, 1, 1);
        
        // Refresh Button
        let refreshButton = new Gtk.Button({
            label: _("Refresh"),
            vexpand: false,
            valign: Gtk.Align.END
        });
        refreshButton.connect("clicked", () => {
            this._parent.daemon.discovering = true;
        });
        this.attach(refreshButton, 0, 2, 1, 1);
        
        // Device Stack
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        this.attach(this.stack, 1, 1, 1, 2);
        
        this._addDaemon();
        
        this.sidebar.connect("row-selected", (listbox, row) => {
            if (row === null) {
                this.sidebar.select_row(this.defaultRow);
            } else {
                this.stack.set_visible_child_name(row.device.id);
            }
        });
    },
    
    _addDaemon: function () {
        // Default Sidebar Entry
        this.defaultRow = new PreferencesWidget.Row({ selectable: true });
        this.defaultRow.device = { id: "default" };
        
        let icon = new Gtk.Image({
            icon_name: "computer-symbolic",
            icon_size: Gtk.IconSize.SMALL_TOOLBAR
        });
        this.defaultRow.grid.attach(icon, 0, 0, 1, 1);
        let nameLabel = new Gtk.Label({ label: "" });
        Common.Settings.bind(
            "public-name",
            nameLabel,
            "label",
            Gio.SettingsBindFlags.DEFAULT
        );
        this.defaultRow.grid.attach(nameLabel, 1, 0, 1, 1);
        this.sidebar.add(this.defaultRow);
        
        let separatorRow = new Gtk.ListBoxRow({
            can_focus: false,
            activatable: false,
            selectable: false
        });
        separatorRow.add(new Gtk.Separator());
        this.sidebar.add(separatorRow);
        
        // Default Page
        // TODO: this could be much better
        let page = new PreferencesWidget.Page();
        page.box.margin_left = 36;
        page.box.margin_right = 36;
        
        let serviceSection = page.addSection(null, null, { width_request: -1 });
        serviceSection.addGSetting("public-name");
        
        let helpSection = page.addSection(_("Connecting Devices"), null, { width_request: -1 });
        let defaultPageLabel = new Gtk.Label({
            label: _("Ensure that devices are on the same local network with ports 1716 to 1764 open for TCP and UDP connections.\n\n") +
                   _("To connect an Android device, install the KDE Connect Android app from the <a href=\"https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp\">Google Play Store</a> or <a href=\"https://f-droid.org/repository/browse/?fdid=org.kde.kdeconnect_tp\">F-Droid</a>.\n\n") +
                   _("Please see the <a href=\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki\">Wiki</a> for more help or <a href =\"https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues\">open an issue</a> on Github to report a problem."),
            wrap: true,
            use_markup: true,
            vexpand: true,
            xalign: 0
        });
        let helpRow = helpSection.addRow();
        helpRow.grid.attach(defaultPageLabel, 0, 0, 1, 1);
        
        this.stack.add_titled(page, "default", "Default");
        
        this.sidebar.select_row(this.defaultRow);
    },
    
    addDevice: function (daemon, dbusPath) {
        let device = daemon.devices.get(dbusPath);
        
        // Device Sidebar Entry
        let row = new PreferencesWidget.Row({ selectable: true });
        row.device = device;
        
        let metadata = DeviceMetadata[device.type];
        
        let icon = new Gtk.Image({
            icon_name: metadata.symbolic_icon,
            icon_size: Gtk.IconSize.SMALL_TOOLBAR
        });
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
        let metadata = DeviceMetadata[device.type];
        
        let infoSection = this.addSection(null, null, { width_request: -1 });
        let statusRow = infoSection.addRow();
        
        // Info Section // Type Icon
        let typeIcon = new Gtk.Image({
            icon_name: metadata.icon,
            icon_size: Gtk.IconSize.DIALOG,
            xalign: 0
        });
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
            image: new Gtk.Image({
                icon_name: "view-refresh-symbolic",
                icon_size: Gtk.IconSize.BUTTON
            }),
            always_show_image: true,
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
                stateButton.image = new Gtk.Image({
                    icon_name: "channel-secure-symbolic",
                    icon_size: Gtk.IconSize.BUTTON,
                    // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                    tooltip_markup: _("Unpair <b>%s</b>").format(this.device.name)
                });
            } else if (this.device.connected && !this.device.paired) {
                stateButton.image = new Gtk.Image({
                    icon_name: "channel-insecure-symbolic",
                    icon_size: Gtk.IconSize.BUTTON,
                    tooltip_markup:
                    // TRANSLATORS: eg. Pair <b>Google Pixel</b>
                    // PLEASE KEEP NEWLINE CHARACTERS (\n)
                    _("Pair <b>%s</b>\n\n").format(this.device.name) +
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
                });
            } else {
                stateButton.image = new Gtk.Image({
                    icon_name: "view-refresh-symbolic",
                    icon_size: Gtk.IconSize.BUTTON,
                    // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                    tooltip_markup: _("Reconnect <b>%s</b>").format(this.device.name)
                });
            }
        });
        this.device.notify("paired");
        statusRow.grid.attach(stateButton, 2, 0, 1, 2);
        
        // Info Section // Remove Button
        let removeButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "user-trash-symbolic",
                icon_size: Gtk.IconSize.BUTTON
            }),
            // TRANSLATORS: eg. Remove <b>Google Pixel</b> Smartphone
            tooltip_markup: _("Remove <b>%s</b>").format(this.device.name),
            always_show_image: true,
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
        let pluginsSection = this.addSection(
            _("Plugins"),
            null, 
            { width_request: -1 }
        );
        
        for (let name of this.device.supportedPlugins) {
            let metadata = imports.service.plugins[name].METADATA;
            
            pluginsSection.addSetting(
                metadata.summary,
                metadata.description,
                new PluginControl(this, name)
            );
        }
        
        pluginsSection.list.set_sort_func((row1, row2) => {
            return row1.summary.label.localeCompare(row2.summary.label);
        });
        
        // Keyboard Shortcuts
        let keySection = this.addSection(
            _("Keyboard Shortcuts"),
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        let keyRow = keySection.addRow();
        keyRow.grid.margin = 0;
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


var DeviceMetadata = {
    desktop: {
        type: _("Desktop"),
        icon: "computer",
        symbolic_icon: "computer-symbolic"
    },
    laptop: {
        type: _("Laptop"),
        icon: "computer",
        symbolic_icon: "laptop-symbolic"
    },
    phone: {
        type: _("Smartphone"),
        icon: "phone",
        symbolic_icon: "smartphone-symbolic"
    },
    tablet: {
        type: _("Tablet"),
        icon: "tablet",
        symbolic_icon: "tablet-symbolic"
    },
    unknown: {
        type: _("Unknown"),
        icon: "computer",
        symbolic_icon: "computer-symbolic"
    }
};

