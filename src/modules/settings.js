"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Keybindings = imports.modules.keybindings;


/**
 *
 */
function section_separators(row, before) {
    if (before) {
        row.set_header(
            new Gtk.Separator({
                orientation: Gtk.Orientation.HORIZONTAL,
                visible: true
            })
        );
    }
};


/**
 * Map @key on @obj.settings to @label ...
 */
// FIXME: this is garbage
function mapWidget(obj, key, widget, map) {
    let row = widget.get_parent().get_parent();

    if (obj && obj.settings) {
        // ...
        let variant = obj.settings.get_value(key);
        let type = variant.get_type_string();

        // Init the widget
        // TODO: hacky
        let value = variant.unpack();
        let mappedValue = map.get(value);
        widget.label = (mappedValue !== undefined) ? mappedValue : value.toString();

        // Watch settings for changes
        let _changed = obj.settings.connect("changed::" + key, (settings) => {
            let val = obj.settings.get_value(key).unpack();
            let mappedVal = map.get(val);
            widget.label = (mappedVal !== undefined) ? mappedVal : value.toString();
        });
        widget.connect("destroy", () => obj.settings.disconnect(_changed));

        // Watch the Gtk.ListBox for activation
        row.get_parent().connect("row-activated", (box, arow) => {
            if (row === arow) {
                let currentValue = obj.settings.get_value(key).unpack();
                let next = false;
                let newValue;

                for (let [k, v] of map) {
                    if (next) {
                        newValue = k;
                        break;
                    } else if (k === currentValue) {
                        next = true;
                    }
                }

                newValue = (newValue) ? newValue : map.keys().next().value;
                obj.settings.set_value(key, new GLib.Variant(type, newValue));
            }
        });
    } else {
        row.visible = false;
    }
};


function mapBool(obj, key, label, [on, off]=[true, false]) {
    let map = new Map([
        [on, _("On")],
        [off, _("Off")]
    ]);

    return mapWidget(obj, key, label, map);
};


function mapAllow(obj, key, label) {
    let map = new Map([
        [1, _("Off")],
        [2, _("Out")],
        [4, _("In")],
        [6, _("Both")]
    ]);

    return mapWidget(obj, key, label, map);
};


function mapSwitch(obj, widget, [on, off]=[6, 4]) {
    let row = widget.get_parent().get_parent();

    if (obj && obj.settings) {
        // Init the widget
        widget.active = (obj.settings.get_uint("allow") === on);

        widget.connect("notify::active", () => {
            obj.settings.set_uint("allow", (widget.active) ? on : off);
        });

        // Watch settings for changes
        let _changed = obj.settings.connect("changed::allow", (settings) => {
            widget.active = (obj.settings.get_uint("allow") === on);
        });
        widget.connect("destroy", () => obj.settings.disconnect(_changed));
    } else {
        row.visible = false;
    }
};


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
        this.set_name(params.name);

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


/**
 * A row for a section of settings
 */
var SectionRow = new Lang.Class({
    Name: "GSConnectSectionRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params) {
        let icon_name = params.icon_name;
        delete params.icon_name;
        let title = params.title;
        delete params.title;
        let subtitle = params.subtitle;
        delete params.subtitle;
        let widget = params.widget;
        delete params.widget;

        params = Object.assign({
            activatable: true,
            selectable: false,
            height_request: 56,
            visible: true
        }, params);
        this.parent(params);

        this.grid = new Gtk.Grid({
            column_spacing: 12,
            margin_top: 8,
            margin_right: 12,
            margin_bottom: 8,
            margin_left: 12,
            visible: true
        });
        this.add(this.grid);

        if (icon_name) {
            this.icon = new Gtk.Image({
                gicon: new Gio.ThemedIcon({
                    names: [ icon_name, "system-run-symbolic" ]
                }),
                pixel_size: 32,
                visible: true
            });

            this.height_request = 56;
            this.grid.attach(this.icon, 0, 0, 1, 2);
        }

        if (title) {
            this.title = new Gtk.Label({
                label: title,
                halign: Gtk.Align.START,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            this.grid.attach(this.title, 1, 0, 1, 1);
        }

        if (subtitle) {
            this.subtitle = new Gtk.Label({
                label: subtitle,
                halign: Gtk.Align.START,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            this.subtitle.get_style_context().add_class("dim-label");
            this.grid.attach(this.subtitle, 1, 1, 1, 1);
        }

        if (widget) {
            this.widget = widget;
            this.grid.attach(this.widget, 2, 0, 1, 2);
        }
    }
});


var SettingsWindow = new Lang.Class({
    Name: "GSConnectSettingsWindow",
    Extends: Gtk.ApplicationWindow,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/settings.ui",
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

    _init: function (device=null) {
        this.parent({
            application: Gio.Application.get_default(),
            visible: true
        });
        this.daemon = this.application;
        this.connect("delete-event", () => this.daemon._pruneDevices());

        this.headerbar = new Gtk.HeaderBar({
            title: this.daemon.name,
            show_close_button: true,
            visible: true
        });
        this.set_titlebar(this.headerbar);

        // Sidebar
        this.help.type = "device";
        this.switcher.set_header_func(this._switcher_separators);
        this.switcher.connect("row-selected", (box, row) => {
            row = row || this.switcher.get_row_at_index(0);
            let name = row.get_name() || null;

            this.stack.set_visible_child_name(name);

            if (this.sidebar.get_child_by_name(name)) {
                if (this.headerbar) {
                    this.headerbar.title = row.title.label;
                } else {
                    this.get_toplevel().get_titlebar().title = row.title.label;
                }

                this.sidebar.set_visible_child_name(name);
                this._prevButton.visible = true;
            }
        });
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // FIXME FIXME
        // Init UI Elements
        this._setHeaderbar();
        this._connectTemplate();

        this.daemon.connect("notify::devices", () => this._devicesChanged());
        this._devicesChanged();

        // Broadcasting
        this.connect("destroy", () => GLib.source_remove(this._refreshSource));

        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                if (this.sidebar.get_visible_child_name() === "switcher") {
                    this.daemon.broadcast();
                }
                return true;
            }
        );
    },

    /**
     * UI Setup and template connecting
     */
    _setHeaderbar: function () {
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
        this.headerbar.pack_start(this._prevButton);
    },

    _connectTemplate: function () {
        // Shell
        mapBool(gsconnect, "show-indicators", this.show_indicators);
        mapBool(gsconnect, "show-offline", this.show_offline);
        mapBool(gsconnect, "show-unpaired", this.show_unpaired);
        mapBool(gsconnect, "show-battery", this.show_battery);
        this.shell_list.set_header_func(section_separators);

        // Extensions
        mapBool(gsconnect, "nautilus-integration", this.files_integration);
        mapBool(gsconnect, "webbrowser-integration", this.webbrowser_integration);
        this.extensions_list.set_header_func(section_separators);

        // Application Extensions
        mapBool(gsconnect, "debug", this.debug_mode);
        this.debug_window.connect("clicked", () => {
            GLib.spawn_command_line_async(
                'gnome-terminal ' +
                '--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ' +
                '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
            );
        });
        this.advanced_list.set_header_func(section_separators);
    },

    _devicesChanged: function () {
        for (let dbusPath of this.daemon.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(this.daemon, dbusPath);
            }
        }

        this.stack.foreach((child) => {
            if (child.row) {
                let name = child.row.get_name();
                if (this.daemon.devices.indexOf(name) < 0) {
                    this.stack.get_child_by_name(name).destroy();
                }
            }
        });

        this.help.visible = (!this.daemon.devices.length);
    },

    /**
     * Header Funcs
     */
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

    addDevice: function (daemon, dbusPath) {
        let device = daemon._devices.get(dbusPath);
        let meta = DeviceMetadata[device.type];

        // Separate device settings widgets
        let panel = new DeviceSettings(daemon, device);
        let switcher = panel.switcher;

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


const AllowTraffic = {
    OFF: 1,
    OUT: 2,
    IN: 4
};


var DeviceSettings = Lang.Class({
    Name: "GSConnectDeviceSettings",
    Extends: Gtk.Stack,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/device.ui",
    Children: [
        "switcher",
        // Device
        "device-status-list",
        "device-icon", "device-name", "device-type",
        "battery-level", "battery-percent", "battery-condition",
        "device-connected", "device-connected-text",
        "device-paired", "device-paired-text",
        // Commands
        "commands", "runcommand-local-list", "runcommand-remote-list",
        "command-edit", "command-edit-icon", "command-edit-name", "command-edit-command",
        "command-edit-cancel", "command-edit-apply",
        // Notifications
        "notification", "notification-page",
        "notification-allow", "notification-apps",
        // Sharing
        "sharing", "sharing-page", "sharing-list",
        "battery-allow", "share-allow", "clipboard-allow", "mpris-allow",
        "mousepad-allow", "findmyphone-allow",
        // Shortcuts
        "shortcuts-list"
    ],

    _init: function (daemon, device) {
        this.parent();

        this.daemon = daemon;
        this.device = device;

        this.switcher.connect("row-selected", (box, row) => {
            this.set_visible_child_name(row.get_name());
        });

        this._infoPage();
        this._runcommandSettings();
        this._notificationSettings();
        this._sharingSettings();

        this._keyboardShortcuts();
    },

    /**
     * Info Page
     */
    _infoPage: function () {
        let meta = DeviceMetadata[this.device.type]
        this.device_name.label = "<big><b>" + this.device.name + "</b></big>";
        this.device_type.label = meta.type;
        this.device_icon.icon_name = meta.icon;

        // Connected
        let connectedRow = this.device_connected.get_parent().get_parent();
        connectedRow.get_parent().connect("row-activated", (box, arow) => {
            if (connectedRow === arow && !this.device.connected) {
                this.device.activate();
            }
        });
        this.device.connect("notify::connected", () => {
            let [on, off] = ["emblem-ok-symbolic", "emblem-synchronizing-symbolic"];

            if (this.device.connected) {
                this.device_connected.icon_name = on;
                this.device_connected_text.label = _("Device is connected");
                connectedRow.set_tooltip_markup(null);
            } else {
                this.device_connected.icon_name = off;
                this.device_connected_text.label = _("Device is disconnected");
                connectedRow.set_tooltip_markup(
                    // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                    _("Reconnect <b>%s</b>").format(this.device.name)
                );

                let pairedRow = this.device_paired.get_parent().get_parent();
                pairedRow.sensitive = this.device.paired;
            }
        });
        this.device.notify("connected");

        // Paired
        let pairedRow = this.device_paired.get_parent().get_parent();
        pairedRow.get_parent().connect("row-activated", (box, arow) => {
            if (pairedRow === arow) {
                if (this.device.paired) {
                    this.device.unpair();
                } else {
                    this.device.pair();
                }
            }
        });
        this.device.connect("notify::paired", () => {
            let [on, off] = ["emblem-ok-symbolic", "emblem-synchronizing-symbolic"];

            if (this.device.paired) {
                this.device_paired.icon_name = "channel-secure-symbolic";
                this.device_paired_text.label = _("Device is paired");
                pairedRow.set_tooltip_markup(
                    // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                    _("Unpair <b>%s</b>").format(this.device.name)
                );
                pairedRow.sensitive = true;
            } else {
                this.device_paired.icon_name = "channel-insecure-symbolic";
                this.device_paired_text.label = _("Device is unpaired");
                pairedRow.set_tooltip_markup(
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
                pairedRow.sensitive = this.device.connected;
            }
        });
        this.device.notify("paired");
        this.device_status_list.set_header_func(section_separators);

        // Battery Level Bar
        let battery = this.device._plugins.get("battery");

        if (battery) {
            this.battery_level.get_style_context().add_class("battery-bar");

            battery.connect("notify", (plugin) => {
                let level = battery.level;

                this.battery_level.visible = (level > -1);
                this.battery_condition.visible = (level > -1);
                this.battery_percent.visible = (level > -1);

                if (level > -1) {
                    this.battery_level.value = level;
                    this.battery_percent.label = _("%d%%").format(level);

                    if (battery.charging) {
                        this.battery_condition.label = _("Charging...");
                    } else if (level < 10) {
                        this.battery_condition.label = _("Caution");
                    } else if (level < 30) {
                        this.battery_condition.label = _("Low");
                    } else if (level < 60) {
                        this.battery_condition.label = _("Good");
                    } else if (level >= 60) {
                        this.battery_condition.label = _("Full");
                    }
                }

            });
            battery.notify("level");
        }
    },

    /**
     * RunCommand Page
     * TODO: maybe action<->commands?
     */
    _runcommandSettings: function () {
        let runcommand = this.device._plugins.get("runcommand");

        if (runcommand) {
            // Edit Command dialog
            this.command_edit_name.connect("changed", () => {
                this.command_edit_icon.gicon = new Gio.ThemedIcon({
                    names: [
                        this.command_edit_name.text.toLowerCase(),
                        "application-x-executable"
                    ]
                });
            });
            this.command_edit_name.connect("activate", () => this._applyCommand());
            this.command_edit_command.connect("icon-release", () => this._openCommand());
            this.command_edit_command.connect("activate", () => this._applyCommand());
            this.command_edit_cancel.connect("clicked", () => this._cancelCommand());
            this.command_edit_apply.connect("clicked", () => this._applyCommand());

            // Local Command List
            let commands = runcommand.settings.get_string("command-list");
            this._commands = JSON.parse(commands);

            this.runcommand_local_list.set_sort_func((row1, row2) => {
                // The add button
                if (row1.get_child() instanceof Gtk.Image) {
                    return 1;
                } else if (row2.get_child() instanceof Gtk.Image) {
                    return -1;
                // Compare uuid?
                } else if (row1.uuid && row1.uuid === row2.get_name()) {
                    return 1;
                } else if (row2.uuid && row2.uuid === row1.get_name()) {
                    return -1;
                // Shouldn't happen?!
                } else if (!row1.title || !row2.title) {
                    return 0;
                }

                return row1.title.label.localeCompare(row2.title.label);
            });
            this.runcommand_local_list.set_header_func(section_separators);
            this._populateCommands();
        } else {
            this.commands.visible = false;
        }
    },

    _populateCommands: function () {
        this.runcommand_local_list.foreach((row) => {
            if (["add-command", "command-edit"].indexOf(row.get_name()) < 0) {
                row.destroy();
            }
        });

        for (let uuid in this._commands) {
            let row = new SectionRow({
                icon_name: this._commands[uuid].name.toLowerCase(),
                title: this._commands[uuid].name,
                subtitle: this._commands[uuid].command
            });
            row.set_name(uuid);

            row.cmdRemove = new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: "document-edit-symbolic",
                    pixel_size: 16,
                    visible: true
                }),
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            row.cmdRemove.get_style_context().add_class("circular");
            row.cmdRemove.get_style_context().add_class("flat");
            row.cmdRemove.connect("clicked", () => this._editCommand(row, uuid));
            row.grid.attach(row.cmdRemove, 2, 0, 1, 2);

            this.runcommand_local_list.add(row);
        }
    },

    _applyCommand: function () {
        let cmd = this._commands[this.command_edit.uuid];
        cmd.name = this.command_edit_name.text.slice(0);
        cmd.command = this.command_edit_command.text.slice(0);

        this.device._plugins.get("runcommand").settings.set_string(
            "command-list",
            JSON.stringify(this._commands)
        );

        this._populateCommands();
        this._cancelCommand();
    },

    _cancelCommand: function () {
        delete this.command_edit.title;
        this.command_edit_name.text = "";
        this.command_edit_command.text = "";

        this.runcommand_local_list.foreach((row) => {
            if (row.get_name() === this.command_edit.uuid) {
                row.visible = true;
            }
        });
        delete this.command_edit.uuid;

        this.command_edit.visible = false;
        this.runcommand_local_list.invalidate_sort();
    },

    _editCommand: function (row, uuid) {
        this.command_edit.uuid = uuid;
        this.command_edit_name.text = this._commands[uuid].name.slice(0);
        this.command_edit_command.text = this._commands[uuid].command.slice(0);

        this.command_edit.title = { label: this.command_edit_name.text };
        this.runcommand_local_list.foreach((row) => {
            if (row.get_name() === uuid) {
                row.visible = false;
            }
        });

        this.command_edit.visible = true;
        this.runcommand_local_list.invalidate_sort();
    },

    _openCommand: function () {
        if (pos === Gtk.EntryIconPosition.SECONDARY) {
            let filter = new Gtk.FileFilter();
            filter.add_mime_type("application/x-executable");
            let dialog = new Gtk.FileChooserDialog({ filter: filter });
            dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
            dialog.add_button(_("Open"), Gtk.ResponseType.OK);

            if (dialog.run() === Gtk.ResponseType.OK) {
                this.command_edit_command.text = dialog.get_filename();
            }

            dialog.destroy();
        }
    },

    /**
     * Notification Settings
     */
    _notificationSettings: function () {
        let notification = this.device._plugins.get("notification");

        if (notification) {
            mapSwitch(notification, this.notification_allow, [ 6, 4 ]);

            // Populate, sort and separate
            this._populateApplications(notification);
            this.notification_apps.set_sort_func((row1, row2) => {
                return row1.title.label.localeCompare(row2.title.label);
            });
            this.notification_apps.set_header_func(section_separators);

            // Map "row-activated" to notification settings
            this.notification_apps.connect("row-activated", (box, row) => {
                if (row.enabled.label === _("On")) {
                    this._notification_apps[row.title.label].enabled = false;
                    row.enabled.label = _("Off")
                } else {
                    this._notification_apps[row.title.label].enabled = true;
                    row.enabled.label = _("On")
                }
                notification.settings.set_string(
                    "applications",
                    JSON.stringify(this._notification_apps)
                );
            });

            this.notification_allow.bind_property(
                "active",
                this.notification_apps,
                "sensitive",
                GObject.BindingFlags.SYNC_CREATE
            );
        } else {
            this.notification.visible = false;
            this.notification_page.visible = false;
        }
    },

    _populateApplications: function (notification) {
        this._queryApplications(notification);

        for (let name in this._notification_apps) {
            let row = new SectionRow({
                icon_name: this._notification_apps[name].iconName,
                title: name,
                height_request: 48
            });

            row.enabled = new Gtk.Label({
                label: this._notification_apps[name].enabled ? _("On") : _("Off"),
                margin_end: 12,
                halign: Gtk.Align.END,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            row.grid.attach(row.enabled, 2, 0, 1, 1);

            this.notification_apps.add(row);
        }
    },

    _queryApplications: function (notification) {
        try {
            this._notification_apps = JSON.parse(
                notification.settings.get_string("applications")
            );
        } catch (e) {
            debug(e);
            this._notification_apps = {};
        }

        let apps = [];

        // Query Gnome's notification settings
        let desktopSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.notifications"
        });

        for (let app of desktopSettings.get_strv("application-children")) {
            let appSettings = new Gio.Settings({
                schema_id: "org.gnome.desktop.notifications.application",
                path: "/org/gnome/desktop/notifications/application/" + app + "/"
            });

            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string("application-id")
            );

            if (appInfo) {
                apps.push(appInfo);
            }
        }

        // Include applications that statically declare to show notifications
        Gio.AppInfo.get_all().map(appInfo => {
            if (appInfo.get_boolean("X-GNOME-UsesNotifications")) {
                apps.push(appInfo);
            }
        });

        // Update GSettings
        apps.map(appInfo => {
            let appName = appInfo.get_name();

            if (appName && !this._notification_apps[appName]) {
                this._notification_apps[appName] = {
                    iconName: appInfo.get_icon().to_string(),
                    enabled: true
                };
            }
        });

        notification.settings.set_string(
            "applications",
            JSON.stringify(this._notification_apps)
        );
    },

    /**
     * Sharing Settings
     */
    _sharingSettings: function () {
        // Battery
        if (this.device.incomingCapabilities.indexOf("kdeconnect.battery") > -1) {
            let battery = this.device._plugins.get("battery");
            mapBool(battery, "allow", this.battery_allow, [ 6, 4 ]);
        } else {
            this.battery_allow.get_parent().get_parent().visible = false;
        }

        // Direct Share
        let share = this.device._plugins.get("share");
        mapBool(share, "allow", this.share_allow, [ 6, 2 ]);

        // Clipboard Sync
        let clipboard = this.device._plugins.get("clipboard");
        mapAllow(clipboard, "allow", this.clipboard_allow);

        // Media Players
        let mpris = this.device._plugins.get("mpris");
        mapAllow(mpris, "allow", this.mpris_allow);

        // Mouse & Keyboard input
        let mousepad = this.device._plugins.get("mousepad");
        mapBool(mousepad, "allow", this.mousepad_allow, [ 6, 2 ]);

        // Location Sharing
        let findmyphone = this.device._plugins.get("findmyphone");
        mapAllow(findmyphone, "allow", this.findmyphone_allow);

        // row separators
        this.sharing_list.set_header_func(section_separators);

//        this.sharing_list.set_sort_func((row1, row2) => {
//            return row1.title.label.localeCompare(row2.title.label);
//        });
    },

    /**
     * Keyboard Shortcuts
     */
    _keyboardShortcuts: function () {
        this._keybindings = JSON.parse(
            this.device.settings.get_string("keybindings")
        );

        for (let name of this.device.list_actions().sort()) {
            let action = this.device.lookup_action(name)

            if (!action.parameter_type) {
                let widget = new Gtk.Label({
                    label: this._keybindings[action.name] || _("Disabled"),
                    visible: true
                });
                widget.get_style_context().add_class("dim-label");

                let meta = (action.getMeta) ? action.getMeta() : {};
                let row = new SectionRow({
                    title: meta.summary || name,
                    subtitle: meta.description || name,
                    widget: widget
                });
                row.name = name;
                row.meta = meta;
                this.shortcuts_list.add(row);
            }
        }

        this.shortcuts_list.connect("row-activated", (box, row) => {
            let dialog = new Keybindings.ShortcutEditor({
                name: row.name,
                summary: row.meta.summary,
                transient_for: this.get_toplevel()
            });

            dialog.connect("response", (dialog, response) => {
                if (response === Gtk.ResponseType.OK) {
                    this._keybindings[dialog.name] = dialog.result;
                } else if (response === 1) {
                    this._keybindings[dialog.name] = "";
                }

                this.device.settings.set_string(
                    "keybindings",
                    JSON.stringify(this._keybindings)
                );
                dialog.destroy();
            });

            dialog.run();
        });
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

