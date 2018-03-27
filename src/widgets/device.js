"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const KeybindingsWidget = imports.widgets.keybindings;
const PreferencesWidget = imports.widgets.preferences;


var HelpSection = new Lang.Class({
    Name: "GSConnectHelpSection",
    Extends: PreferencesWidget.Section,

    _init: function () {
        this.parent({ margin_bottom: 0, width_request: -1 });

        let label = new Gtk.Label({
            label: _("Ensure that devices are on the same local network with ports 1716 to 1764 open for TCP and UDP connections.") +
                   "\n\n" +
                   _('To connect an Android device, install the KDE Connect Android app from the <a href="%s">Google Play Store</a> or <a href="%s">F-Droid</a>.').format(
                       "https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp",
                       "https://f-droid.org/repository/browse/?fdid=org.kde.kdeconnect_tp"
                   ) +
                   "\n\n" +
                   _('Please see the <a href="%s">Wiki</a> for more help or <a href="%s">open an issue</a> on Github to report a problem.').format(
                       "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki",
                       "https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues"
                   ),
            wrap: true,
            use_markup: true,
            vexpand: true,
            xalign: 0
        });

        this.addRow().grid.attach(label, 0, 0, 1, 1);
    }
});


/** Gtk widget for plugin enabling/disabling */
var PluginControl = new Lang.Class({
    Name: "GSConnectPluginControl",
    Extends: Gtk.Grid,

    _init: function (device, name) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            column_spacing: 12,
            vexpand: true,
            valign: Gtk.Align.CENTER
        });

        this.device = device;
        this.name = name;
        this._freeze = false;

        if (imports.service.plugins[this.name].SettingsDialog) {
            this.settingButton = new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: "emblem-system-symbolic",
                    pixel_size: 16
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
            pixel_size: 24,
            visible: true
        });

        this.device.settings.connect("changed::enabled-plugins", () => {
            this._refresh();
        });

        this._refresh();
    },

    _refresh: function () {
        this._freeze = true;
        let enabledPlugins = this.device.settings.get_strv("enabled-plugins");
        this.pluginSwitch.active = (enabledPlugins.indexOf(this.name) > -1);
        this._freeze = false;
    },

    _toggle: function (widget) {
        if (!this._freeze) {
            let result, success, error;

            if (this.pluginSwitch.active) {
                result = this.device.enablePlugin(this.name);
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
                this.device.disablePlugin(this.name);
            }
        }
    },

    _configure: function () {
        let dialog = new imports.service.plugins[this.name].SettingsDialog(
            this.device,
            this.name,
            this.get_toplevel()
        );

        if (dialog.run() === Gtk.ResponseType.APPLY) {
            dialog.settings.apply();
        }

        dialog.close();
    }
});


var PluginSection = new Lang.Class({
    Name: "GSConnectPluginSection",
    Extends: PreferencesWidget.Section,

    _init: function (device) {
        this.parent({ width_request: -1 });

        this.device = device;

        for (let name of this.device.supportedPlugins) {
            let metadata = imports.service.plugins[name].METADATA;

            this.addSetting(
                metadata.summary,
                metadata.description,
                new PluginControl(this.device, name)
            );
        }

        this.list.set_sort_func((row1, row2) => {
            return row1.summary.label.localeCompare(row2.summary.label);
        });
    }
});


var KeybindingsSection = new Lang.Class({
    Name: "GSConnectKeybindingsSection",
    Extends: PreferencesWidget.Section,

    _init: function (device) {
        this.parent({ margin_bottom: 0, width_request: -1 });

        this.device = device;

        let keyRow = this.addRow();
        keyRow.grid.margin = 0;
        let keyView = new KeybindingsWidget.TreeView(this.device.settings, "keybindings");
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

        keyView.setAccels(
            JSON.parse(this.device.settings.get_string("keybindings"))
        );
        keyRow.grid.attach(keyView, 0, 0, 1, 1);
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

        this.sidebar.set_header_func((row, before) => {
            if (row.get_index() === 1) {
                row.set_header(
                    new Gtk.Separator({
                        orientation: Gtk.Orientation.HORIZONTAL
                    })
                );
            }
        });
    },

    _addDaemon: function () {
        // Default Sidebar Entry
        this.defaultRow = new PreferencesWidget.Row({
            height_request: -1,
            margin_bottom: 12,
            margin_top: 12,
            selectable: true
        });
        this.defaultRow.device = { id: "default" };

        let icon = new Gtk.Image({
            icon_name: "org.gnome.Shell.Extensions.GSConnect-symbolic",
            pixel_size: 16
        });
        this.defaultRow.grid.attach(icon, 0, 0, 1, 1);
        let nameLabel = new Gtk.Label({ label: "" });
        ext.settings.bind(
            "public-name",
            nameLabel,
            "label",
            Gio.SettingsBindFlags.DEFAULT
        );
        this.defaultRow.grid.attach(nameLabel, 1, 0, 1, 1);
        this.sidebar.add(this.defaultRow);

        // Default Page
        // TODO: this could be much better
        let page = new PreferencesWidget.Page();
        page.box.margin_left = 36;
        page.box.margin_right = 36;

        let serviceSection = page.addSection(null, null, { width_request: -1 });
        serviceSection.addGSetting(ext.settings, "public-name");

        page.addSection(_("Connecting Devices"), new HelpSection());

        this.stack.add_named(page, "default");

        this.sidebar.select_row(this.defaultRow);
    },

    addDevice: function (daemon, dbusPath) {
        let device = daemon.devices.get(dbusPath);

        // Device Sidebar Entry
        let row = new PreferencesWidget.Row({
            height_request: -1,
            margin_bottom: 12,
            margin_top: 12,
            selectable: true
        });
        row.device = device;

        let metadata = DeviceMetadata[device.type];

        let icon = new Gtk.Image({
            icon_name: metadata.symbolic_icon,
            pixel_size: 16
        });
        device.connect("notify::paired", () => {
            if (device.paired) {
                icon.icon_name = metadata.symbolic_icon;
            } else {
                icon.icon_name = metadata.unpaired_icon;
            }
        });
        row.grid.attach(icon, 0, 0, 1, 1);
        let nameLabel = new Gtk.Label({ label: device.name });
        row.grid.attach(nameLabel, 1, 0, 1, 1);
        this.sidebar.add(row);

        row.show_all();

        // Device Page
        let page = new Page(daemon, device);
        this.stack.add_named(page, device.id);

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

    _init: function (daemon, device) {
        this.parent();
        this.box.margin_left = 36;
        this.box.margin_right = 36;

        this.daemon = daemon;
        this.device = device;

        // Info Section
        let metadata = DeviceMetadata[device.type];

        let infoSection = this.addSection(null, null, { width_request: -1 });
        let statusRow = infoSection.addRow();

        // Info Section // Type Icon
        let typeIcon = new Gtk.Image({
            icon_name: metadata.icon,
            pixel_size: 48,
            halign: Gtk.Align.START
        });
        statusRow.grid.attach(typeIcon, 0, 0, 1, 2);

        // Info Section // Name and Type Labels
        let nameLabel = new Gtk.Label({
            label: "<b><big>" + device.name + "</big></b>",
            hexpand: true,
            use_markup: true,
            valign: Gtk.Align.END,
            xalign: 0
        });
        statusRow.grid.attach(nameLabel, 1, 0, 1, 1);
        let typeLabel = new Gtk.Label({
            label: metadata.type,
            hexpand: true,
            valign: Gtk.Align.START,
            xalign: 0
        });
        typeLabel.get_style_context().add_class("dim-label");
        statusRow.grid.attach(typeLabel, 1, 1, 1, 1);

        let deviceControls = new Gtk.ButtonBox({
            halign: Gtk.Align.END,
            hexpand: true,
            spacing: 12
        });

        // Info Section // State Button (Pair/Unpair/Connect)
        let connectButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "view-refresh-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
            tooltip_markup: _("Reconnect <b>%s</b>").format(this.device.name),
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        connectButton.get_style_context().add_class("circular");
        connectButton.connect("clicked", () => { this.device.activate(); });
        this.device.bind_property(
            "connected",
            connectButton,
            "visible",
            GObject.BindingFlags.INVERT_BOOLEAN
        );
        statusRow.grid.attach(connectButton, 2, 0, 1, 2);

        let pairButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "view-refresh-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        pairButton.get_style_context().add_class("circular");
        pairButton.connect("clicked", () => {
            if (this.device.paired) {
                this.device.unpair();
            } else {
                this.device.pair();
            }
        });
        this.device.connect("notify", () => {
            if (this.device.paired) {
                pairButton.image = new Gtk.Image({
                    icon_name: "channel-secure-symbolic",
                    pixel_size: 16
                });
                pairButton.set_tooltip_markup(
                    // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                    _("Unpair <b>%s</b>").format(this.device.name)
                );
            } else {
                pairButton.image = new Gtk.Image({
                    icon_name: "channel-insecure-symbolic",
                    pixel_size: 16
                });
                pairButton.set_tooltip_markup(
                    // TRANSLATORS: eg. Pair <b>Google Pixel</b>
                    _("Pair <b>%s</b>").format(this.device.name) + "\n\n" +
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
                pairButton.sensitive = this.device.connected;
            }
        });
        this.device.notify("paired");
        statusRow.grid.attach(pairButton, 3, 0, 1, 2);

        // Plugins
        this.addSection(_("Plugins"), new PluginSection(this.device));

        // Keyboard Shortcuts
        this.addSection(_("Keyboard Shortcuts"), new KeybindingsSection(this.device));

        this.show_all();
        connectButton.visible = !this.device.connected;
    }
});


var DeviceMetadata = {
    desktop: {
        type: _("Desktop"),
        icon: "computer",
        symbolic_icon: "computer-symbolic",
        unpaired_icon: "desktopdisconnected"
    },
    laptop: {
        type: _("Laptop"),
        icon: "laptop",
        symbolic_icon: "laptop-symbolic",
        unpaired_icon: "laptopdisconnected"
    },
    phone: {
        type: _("Smartphone"),
        icon: "phone",
        symbolic_icon: "smartphone-symbolic",
        unpaired_icon: "smartphonedisconnected"
    },
    tablet: {
        type: _("Tablet"),
        icon: "tablet",
        symbolic_icon: "tablet-symbolic",
        unpaired_icon: "tabletdisconnected"
    },
    unknown: {
        type: _("Unknown"),
        icon: "computer",
        symbolic_icon: "computer-symbolic",
        unpaired_icon: "desktopdisconnected"
    }
};

