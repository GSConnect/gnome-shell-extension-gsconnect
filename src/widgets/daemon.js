"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Client = imports.client;
const Common = imports.common;
const DeviceWidget = imports.widgets.device;


/**
 * A simple dialog for selecting a device
 */
var DeviceChooser = new Lang.Class({
    Name: "GSConnectDeviceChooser",
    Extends: Gtk.Dialog,

    _init: function (params) {
        this.parent({
            use_header_bar: true,
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        // HeaderBar
        let headerBar = this.get_header_bar();
        headerBar.title = _("Select a Device");
        headerBar.subtitle = params.title;
        headerBar.show_close_button = false;

        let selectButton = this.add_button(_("Select"), Gtk.ResponseType.OK);
        selectButton.sensitive = false;
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        // Device List
        let scrolledWindow = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.get_content_area().add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect("row-activated", (list, row) => {
            this.response(Gtk.ResponseType.OK);
        });
        this.list.connect("selected-rows-changed", () => {
            selectButton.sensitive = (this.list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        this._populate(params.devices);
        scrolledWindow.show_all();
    },

    _populate: function (devices) {
        for (let device of devices) {
            let row = new Gtk.ListBoxRow();
            row.device = device;
            this.list.add(row);

            let box = new Gtk.Box({
                margin: 6,
                spacing: 6
            });
            row.add(box);

            let icon = new Gtk.Image({
                icon_name: device.type,
                pixel_size: 32
            });
            box.add(icon);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true
            });
            box.add(name);
        }
    }
});


var SidebarRow = new Lang.Class({
    Name: "GSConnectSidebarRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params) {
        this.parent({
            selectable: true,
            visible: true
        });

        this.type = params.type || undefined;
        this.name = params.name || undefined;

        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_left: 8,
            margin_right: 8,
            margin_bottom: 12,
            margin_top: 12,
            visible: true
        });
        this.add(this.box);

        this.icon = new Gtk.Image({
            icon_name: params.icon_name,
            pixel_size: 16,
            visible: true
        });
        this.box.add(this.icon);

        this.title = new Gtk.Label({
            label: params.title,
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        this.box.add(this.title);

        if (params.go_next) {
            this.go_next = new Gtk.Image({
                icon_name: "go-next-symbolic",
                pixel_size: 16,
                halign: Gtk.Align.END,
                visible: true
            });
            this.box.add(this.go_next);
        }
    }
});


var PrefsWidget = Lang.Class({
    Name: "GSConnectPrefsWidget",
    Extends: Gtk.Grid,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/prefs.ui",
    Children: [
        "stack", "switcher", "sidebar",
        "shell-list",
        "show-indicators", "show-offline", "show-unpaired", "show-battery",
        "extensions-list",
        "files-integration", "webbrowser-integration",
        "advanced-list",
        "debug-mode", "debug-window",
        "help", "help-list"
    ],

    _init: function (application=false) {
        this.parent();

        // Sidebar
        this.help.type = "device";
        this.switcher.set_header_func(this._switcher_separators);
        this.switcher.connect("row-selected", (box, row) => {
            row = row || this.switcher.get_row_at_index(0);
            let name = row.name || row.get_name();

            this.stack.set_visible_child_name(name);

            if (this.sidebar.get_child_by_name(name)) {
                this.headerbar.title = row.title.label;
                this.sidebar.set_visible_child_name(name);
                this._prevButton.visible = true;
            }
        });
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // Broadcasting
        this.connect("destroy", () => {
            GLib.source_remove(this._refreshSource);
        });

        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                this.daemon.broadcast();
                return true;
            }
        );

        // FIXME FIXME
        // Init UI Elements
        this._setHeaderbar();
        this._connectTemplate();

        // We were instantiated by the GtkApplication
        if (application) {
            this.daemon = application;

            this.daemon.connect("notify::devices", (daemon) => {
                this._devicesChanged();
            });
            this._devicesChanged();
        // We were instantiated by the Shell, we need a proxy
        } else {
            this.daemon = new Client.Daemon();

            this._watchdog = Gio.bus_watch_name(
                Gio.BusType.SESSION,
                Client.BUS_NAME,
                Gio.BusNameWatcherFlags.NONE,
                (c, n, o) => this._serviceAppeared(c, n, o),
                (c, n) => this._serviceVanished(c, n)
            );
        }
    },

    _bind_bool: function (settings, key, label) {
        // Watch the setting for changes
        settings.connect("changed::" + key, (settings) => {
            label.label = settings.get_boolean(key) ? _("On") : _("Off");
        });
        // Init the label
        label.label = settings.get_boolean(key) ? _("On") : _("Off");

        // Watch the Gtk.ListBox for activations
        let row = label.get_parent().get_parent();
        let box = row.get_parent();

        box.connect("row-activated", (box, arow) => {
            if (row === arow) {
                // Set the boolean to the inverse of the label "value"
                settings.set_boolean(key, (label.label === _("Off")));
            }
        });
    },

    _setHeaderbar: function () {
        // About Button
        let aboutButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "help-about-symbolic",
                pixel_size: 16,
                visible: true
            }),
            always_show_image: true,
            visible: true
        });
        aboutButton.connect("clicked", (button) => {
            let dialog = new Gtk.AboutDialog({
                authors: [ "Andy Holmes <andrew.g.r.holmes@gmail.com>" ],
                //logo_icon_name: ext.app_id,
                logo: GdkPixbuf.Pixbuf.new_from_resource_at_scale(
                    ext.app_path + "/" + ext.app_id + ".svg",
                    128,
                    128,
                    true
                ),
                program_name: _("GSConnect"),
                version: ext.metadata.version,
                website: ext.metadata.url,
                license_type: Gtk.License.GPL_2_0,
                transient_for: this.get_toplevel(),
                modal: true
            });
            dialog.connect("delete-event", dialog => dialog.destroy());
            dialog.show();
        });

        // Previous Button
        this._prevButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "go-previous-symbolic",
                pixel_size: 16,
                visible: true
            }),
            always_show_image: true,
            visible: false
        });
        this._prevButton.connect("clicked", (button) => {
            this.headerbar.title = _("GSConnect");
            this.sidebar.set_visible_child_name("switcher");

            this.switcher.get_row_at_index(0).emit("activate");
            this._prevButton.visible = false;
        });

        // Hack for gnome-shell-extension-prefs
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this.headerbar = this.get_toplevel().get_titlebar();
            this.headerbar.pack_end(aboutButton);
            this.headerbar.pack_start(this._prevButton);
            return false;
        });
    },

    _connectTemplate: function () {
        // Shell
        this._bind_bool(ext.settings, "show-indicators", this.show_indicators);
        this._bind_bool(ext.settings, "show-offline", this.show_offline);
        this._bind_bool(ext.settings, "show-unpaired", this.show_unpaired);
        this._bind_bool(ext.settings, "show-battery", this.show_battery);
        this.shell_list.set_header_func(this._section_separators);

        // Extensions
        this._bind_bool(ext.settings, "nautilus-integration", this.files_integration);
        this._bind_bool(ext.settings, "webbrowser-integration", this.webbrowser_integration);
        this.extensions_list.set_header_func(this._section_separators);

        // Application Extensions
        this._bind_bool(ext.settings, "debug", this.debug_mode);
        this.debug_window.connect("clicked", () => {
            GLib.spawn_command_line_async(
                'gnome-terminal ' +
                '--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ' +
                '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
            );
        });
        this.advanced_list.set_header_func(this._section_separators);
    },

    _devicesChanged: function () {
        let managedDevices = this.daemon.devices || [];

        for (let dbusPath of this.daemon.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(this.daemon, dbusPath);
            }
        }

        this.stack.foreach((child) => {
            if (child.row) {
                if (this.daemon.devices.indexOf(child.row.name) < 0) {
                    this.stack.get_child_by_name(child.row.name).destroy();
                }
            }
        });

        this.help.visible = (!this.daemon.devices.length);
    },

    _serviceAppeared: function (conn, name, name_owner) {
        debug([conn, name, name_owner]);

        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }

        // Watch for new and removed devices
        this.daemon.connect("notify::devices", (daemon) => {
            this._devicesChanged(daemon);
        });
        this._devicesChanged();
    },

    _serviceVanished: function (conn, name) {
        debug([c, n]);

        if (this.daemon) {
            this.daemon.destroy();
            delete this.daemon;
        }

        this.daemon = new Client.Daemon();
    },

    _switcher_separators: function (row, before) {
        if (before && row.type !== before.type) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    _section_separators: function (row, before) {
        if (before) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    addDevice: function (daemon, dbusPath) {
        let device = daemon._devices.get(dbusPath);
        let meta = DeviceWidget.DeviceMetadata[device.type];

        // Separate device settings widgets
        let deviceSettings = new DeviceWidget.Settings(daemon, device);
        let switcher = deviceSettings.switcher;
        deviceSettings.remove(deviceSettings.switcher);
        let panel = deviceSettings.stack;
        deviceSettings.remove(deviceSettings.stack);

        // Add panel switcher to sidebar stack
        panel.connect("destroy", () => switcher.destroy());
        this.sidebar.add_named(switcher, dbusPath);

        // Add device panel stack
        this.stack.add_titled(panel, dbusPath, device.name);

        // Add device to sidebar
        panel.row = new SidebarRow({
            icon_name: device.paired ? meta.symbolic_icon : meta.unpaired_icon,
            title: device.name,
            type: "device",
            name: dbusPath,
            go_next: true
        });

        // Destroy the sidebar row when the panel goes
        panel.connect("destroy", () => panel.row.destroy());

        // Keep the icon up to date
        device.connect("notify::paired", () => {
            if (device.paired) {
                panel.row.icon.icon_name = meta.symbolic_icon;
            } else {
                panel.row.icon.icon_name = meta.unpaired_icon;
            }
        });

        this.switcher.add(panel.row);
    }
});
