"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Keybindings = imports.modules.keybindings;


const AllowTraffic = {
    OFF: 1,
    OUT: 2,
    IN: 4
};


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
 * Map @key on @settings to @label ...
 */
// FIXME: this is garbage
function mapWidget(settings, key, widget, map) {
    let row = widget.get_parent().get_parent();

    if (settings) {
        // ...
        let variant = settings.get_value(key);
        let type = variant.get_type_string();

        // Init the widget
        let value = variant.unpack();
        let mappedValue = map.get(value);
        widget.label = (mappedValue !== undefined) ? mappedValue : value.toString();

        // Watch settings for changes
        let _changed = settings.connect("changed::" + key, (settings) => {
            let val = settings.get_value(key).unpack();
            let mappedVal = map.get(val);
            widget.label = (mappedVal !== undefined) ? mappedVal : value.toString();
        });
        widget.connect("destroy", () => settings.disconnect(_changed));

        // Watch the Gtk.ListBox for activation
        row.get_parent().connect("row-activated", (box, arow) => {
            if (row === arow) {
                let currentValue = settings.get_value(key).unpack();
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

                if (newValue === undefined) {
                    newValue = map.keys().next().value;
                }

                settings.set_value(key, new GLib.Variant(type, newValue));
            }
        });
    } else {
        row.visible = false;
    }
};


function mapBoolFlag(settings, key, label, on) {
    let row = label.get_parent().get_parent();

    if (settings) {
        // Set the intial label
        let value = settings.get_uint(key);
        label.label = (value & on) ? _("On") : _("Off");

        // Watch settings for changes
        let _changed = settings.connect("changed::" + key, (settings) => {
            let value = settings.get_uint(key);
            label.label = (value & on) ? _("On") : _("Off");
        });
        label.connect("destroy", () => settings.disconnect(_changed));

        // Watch the Gtk.ListBox for activation
        row.get_parent().connect("row-activated", (box, arow) => {
            if (row === arow) {
                let value = settings.get_uint(key);
                settings.set_uint(key, value ^ on);
            }
        });
    } else {
        row.visible = false;
    }
};


function mapBool(settings, key, label, [on, off]=[true, false]) {
    let map = new Map([
        [on, _("On")],
        [off, _("Off")]
    ]);

    return mapWidget(settings, key, label, map);
};


function mapAllow(settings, key, label) {
    let map = new Map([
        [1, _("Off")],
        [2, _("To Device")],
        [4, _("From Device")],
        [6, _("Both")]
    ]);

    return mapWidget(settings, key, label, map);
};


function mapSwitch(settings, widget, [on, off]=[6, 4]) {
    let row = widget.get_parent().get_parent();

    if (settings) {
        // Init the widget
        widget.active = (settings.get_uint("allow") === on);

        widget.connect("notify::active", () => {
            settings.set_uint("allow", (widget.active) ? on : off);
        });

        // Watch settings for changes
        let _changed = settings.connect("changed::allow", (settings) => {
            widget.active = (settings.get_uint("allow") === on);
        });
        widget.connect("destroy", () => settings.disconnect(_changed));
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


/**
 * A row for a stack sidebar
 */
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

        // A '>' image for rows that are like submenus
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
        let title = params.title;
        let subtitle = params.subtitle;
        let widget = params.widget;
        delete params.icon_name;
        delete params.title;
        delete params.subtitle;
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
        "headerbar", "headerbar-title", "headerbar-edit", "headerbar-entry",
        "prev-button",
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
        // Hack until template callbacks are supported (GJS 1.54?)
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, connectObj[handlerName].bind(connectObj));
        });

        this.parent({
            application: Gio.Application.get_default(),
            visible: true
        });
        this.service = this.application;

        // Header Bar
        this.headerbar_title.label = this.service.name;

        // Sidebar
        this.help.type = "device";
        this.switcher.set_header_func(this._switcher_separators);
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // Init UI Elements
        this._bindSettings();

        // Broadcasting
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                if (this.sidebar.get_visible_child_name() === "switcher") {
                    this.service.broadcast();
                }
                return true;
            }
        );

        // Setup devices
        this._serviceDevices = this.service.connect("notify::devices", () => {
            this._devicesChanged()
        });
        this._devicesChanged();

        // Cleanup
        this.connect("destroy", () => {
            GLib.source_remove(this._refreshSource);
            this.service._pruneDevices();
            this.service.disconnect(this._serviceDevices);
        });
    },

    /**
     * HeaderBar Callbacks
     */
    _onPrevious: function (button, event) {
        this.headerbar_title.label = this.service.name;
        this.headerbar_edit.visible = true;
        this.sidebar.set_visible_child_name("switcher");

        this.switcher.get_row_at_index(0).emit("activate");
        button.visible = false;
    },

    _onEditServiceName: function (button, event) {
        this.headerbar_entry.text = this.service.name;
        this.headerbar_entry.visible = true;
        this.headerbar_title.visible = false;
        this.headerbar_edit.visible = false;
    },

    _onSetServiceName: function (button, event) {
        this.service.name = this.headerbar_entry.text;
        this.headerbar_title.label = this.service.name;

        this.headerbar_entry.visible = false;
        this.headerbar_title.visible = true;
        this.headerbar_edit.visible = true;
    },

    /**
     * Context Switcher
     */
    _onSwitcherRowSelected: function (box, row) {
        // I guess this is being called before the template children are ready
        if (!this.stack) { return; }

        row = row || this.switcher.get_row_at_index(0);
        let name = row.get_name() || null;

        this.stack.set_visible_child_name(name);

        if (this.sidebar.get_child_by_name(name)) {
            this.headerbar_title.label = row.title.label;
            this.headerbar_edit.visible = false;

            this.sidebar.set_visible_child_name(name);
            this.prev_button.visible = true;
        }
    },

    /**
     * UI Setup and template connecting
     */
    _bindSettings: function () {
        // Shell
        mapBool(gsconnect.settings, "show-indicators", this.show_indicators);
        mapBool(gsconnect.settings, "show-offline", this.show_offline);
        mapBool(gsconnect.settings, "show-unpaired", this.show_unpaired);
        mapBool(gsconnect.settings, "show-battery", this.show_battery);
        this.shell_list.set_header_func(section_separators);

        // Extensions
        // TODO: these should go..
        mapBool(gsconnect.settings, "nautilus-integration", this.files_integration);
        mapBool(gsconnect.settings, "webbrowser-integration", this.webbrowser_integration);
        this.extensions_list.set_header_func(section_separators);

        // Application Extensions
        mapBool(gsconnect.settings, "debug", this.debug_mode);
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
        for (let dbusPath of this.service.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(this.service, dbusPath);
            }
        }

        this.stack.foreach((child) => {
            if (child.row) {
                let name = child.row.get_name();
                if (this.service.devices.indexOf(name) < 0) {
                    this.stack.get_child_by_name(name).destroy();
                }
            }
        });

        this.help.visible = (!this.service.devices.length);
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

    addDevice: function (service, dbusPath) {
        let device = service._devices.get(dbusPath);
        let meta = DeviceMetadata[device.type];

        // Create a new device widget
        let panel = new DeviceSettings(device);

        // Add device to switcher and panel stack
        this.stack.add_titled(panel, dbusPath, device.name);
        this.sidebar.add_named(panel.switcher, dbusPath);

        // Add device to sidebar
        panel.row = new SidebarRow({
            icon_name: (device.paired) ? meta.symbolic_icon : meta.unpaired_icon,
            title: device.name,
            type: "device",
            name: dbusPath,
            go_next: true
        });
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
        // RunCommand
        "commands", "command-list", "command-new", "command-editor",
        "command-icon", "command-name", "command-line",
        "command-trash", "command-save",
        // Notifications
        "notification", "notification-page",
        "notification-allow", "notification-apps",
        // Sharing
        "sharing", "sharing-page", "sharing-list",
        "battery-allow", "share-allow", "clipboard-allow", "mpris-allow",
        "mousepad-allow", "findmyphone-allow",
        // Events
        //TODO
        // Shortcuts
        "shortcuts-list"
    ],

    _init: function (device) {
        // Hack until template callbacks are supported (GJS 1.54?)
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, connectObj[handlerName].bind(connectObj));
        });

        this.parent();

        this.service = Gio.Application.get_default();
        this.device = device;

        this._gsettings = {};
        this._supported = this.device.supportedPlugins();

        this.connect("destroy", () => this.switcher.destroy());

        this.switcher.connect("row-selected", (box, row) => {
            this.set_visible_child_name(row.get_name());
        });

        this._infoPage();
        this._localCommands();
        this._notificationSettings();
        this._sharingSettings();

        this._keyboardShortcuts();
    },

    _getSettings: function (name) {
        if (this._gsettings[name]) {
            return this._gsettings[name];
        }

        if (this._supported.indexOf(name) > -1) {
            let meta = imports.service.plugins[name].Metadata;

            this._gsettings[name] = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(meta.id, -1),
                path: gsconnect.settings.path + ["device", this.device.id, "plugin", name, ""].join("/")
            });
        }

        return (this._gsettings[name]) ? this._gsettings[name] : false;
    },

    _onConnected: function () {
        let connectedRow = this.device_connected.get_parent().get_parent();

        if (this.device.connected) {
            this.device_connected.icon_name = "emblem-ok-symbolic";
            this.device_connected_text.label = _("Device is connected");
            connectedRow.set_tooltip_markup(null);
        } else {
            this.device_connected.icon_name = "emblem-synchronizing-symbolic";
            this.device_connected_text.label = _("Device is disconnected");
            connectedRow.set_tooltip_markup(
                // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                _("Reconnect <b>%s</b>").format(this.device.name)
            );

            let pairedRow = this.device_paired.get_parent().get_parent();
            pairedRow.sensitive = this.device.paired;
        }
    },

    _onPaired: function () {
        let pairedRow = this.device_paired.get_parent().get_parent();

        if (this.device.paired) {
            //this.device_paired.icon_name = "channel-secure-symbolic";
            this.device_paired.icon_name = "application-certificate-symbolic";
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
                _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.name, this.device.fingerprint, this.service.fingerprint)
            );
            pairedRow.sensitive = this.device.connected;
        }
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
            if (connectedRow === arow) {
                this.device.activate();
            }
        });
        this._connectedId = this.device.connect(
            "notify::connected",
            this._onConnected.bind(this)
        );
        this._onConnected();

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
        this._pairedId = this.device.connect(
            "notify::paired",
            this._onPaired.bind(this)
        );
        this._onPaired();

        this.device_status_list.set_header_func(section_separators);

        // Battery Level Bar
        // TODO: this might not be worth the trouble...
        let battery = this.device._plugins.get("battery");

        if (battery) {
            this.battery_level.get_style_context().add_class("battery-bar");

            this._infoBattery = battery.connect("notify", (plugin) => {
                let level = battery.level;
                let active = (level > -1);

                this.battery_level.visible = active;
                this.battery_condition.visible = active;
                this.battery_percent.visible = active;

                if (active) {
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

        // Cleanup
        this.connect("destroy", () => {
            this.device.disconnect(this._connectedId);
            this.device.disconnect(this._pairedId);

            if (this._infoBattery) {
                this.device._plugins.get("battery").disconnect(this._infoBattery);
            }
        });
    },

    /**
     * RunCommand Page
     * TODO: maybe action<->commands?
     */
    _localCommands: function () {
        let runcommand = this._getSettings("runcommand");

        if (runcommand) {
            // Edit Command dialog
            // TODO: move to template
            this.command_name.connect("changed", () => {
                this.command_icon.gicon = new Gio.ThemedIcon({
                    names: [
                        this.command_name.text.toLowerCase(),
                        "application-x-executable"
                    ]
                });
            });

            // Local Command List
            this._commands = gsconnect.full_unpack(
                runcommand.get_value("command-list")
            );

            this.command_list.set_sort_func((row1, row2) => {
                // The add button
                if (row1.get_child() instanceof Gtk.Image) {
                    return 1;
                } else if (row2.get_child() instanceof Gtk.Image) {
                    return -1;
                // Compare uuid???
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
            this.command_list.set_header_func(section_separators);
            this._populateCommands();
        } else {
            this.commands.visible = false;
        }
    },

    _insertCommand: function (uuid) {
        let row = new SectionRow({
            icon_name: this._commands[uuid].name.toLowerCase(),
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            widget: new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: "document-edit-symbolic",
                    pixel_size: 16,
                    visible: true
                }),
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            })
        });
        row.set_name(uuid);
        row.widget.get_style_context().add_class("circular");
        row.widget.get_style_context().add_class("flat");
        row.widget.connect("clicked", () => this._editCommand(row, uuid));

        this.command_list.add(row);

        return row;
    },

    _newCommand: function (box, row) {
        if (row === this.command_new) {
            let uuid = GLib.uuid_string_random();
            this._commands[uuid] = { name: "", command: "" };
            this._editCommand(this._insertCommand(uuid), uuid);
        }
    },

    _populateCommands: function () {
        this.command_list.foreach(row => {
            if (row !== this.command_new && row !== this.command_editor) {
                row.destroy();
            }
        });

        for (let uuid in this._commands) {
            this._insertCommand(uuid);
        }
    },

    _saveCommand: function () {
        if (this.command_name.text && this.command_line.text) {
            let cmd = this._commands[this.command_editor.uuid];
            cmd.name = this.command_name.text.slice(0);
            cmd.command = this.command_line.text.slice(0);
        } else {
            delete this._commands[this.command_editor.uuid];
        }

        this._getSettings("runcommand").set_value(
            "command-list",
            gsconnect.full_pack(this._commands)
        );

        this._resetCommandEditor();
        this._populateCommands();
    },

    _resetCommandEditor: function (button) {
        delete this.command_editor.title;
        this.command_name.text = "";
        this.command_line.text = "";

        this.command_list.foreach(row => {
            if (row.get_name() === this.command_editor.uuid) {
                row.visible = true;
            }
        });
        delete this.command_editor.uuid;

        this.command_new.visible = true;
        this.command_editor.visible = false;
        this.command_list.invalidate_sort();
    },

    _editCommand: function (row, uuid) {
        this.command_editor.uuid = uuid;
        this.command_name.text = this._commands[uuid].name.slice(0);
        this.command_line.text = this._commands[uuid].command.slice(0);

        this.command_editor.title = { label: this.command_name.text };
        this.command_list.foreach(row => {
            if (row.get_name() === uuid) {
                row.visible = false;
            }
        });

        this.command_new.visible = false;
        this.command_editor.visible = true;
        this.command_list.invalidate_sort();
    },

    _browseCommand: function (entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type("application/x-executable");
        let dialog = new Gtk.FileChooserDialog({ filter: filter });
        dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        dialog.add_button(_("Open"), Gtk.ResponseType.OK);

        if (dialog.run() === Gtk.ResponseType.OK) {
            this.command_line.text = dialog.get_filename();
        }

        dialog.destroy();
    },

    _removeCommand: function (button) {
        delete this._commands[this.command_editor.uuid];
        this._getSettings("runcommand").set_value(
            "command-list",
            gsconnect.full_pack(this._commands)
        );

        this._resetCommandEditor();
        this._populateCommands();
    },

    /**
     * Notification Settings
     */
    _notificationSettings: function () {
        let notification = this._getSettings("notification");

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
                    row.enabled.label = _("Off");
                } else {
                    this._notification_apps[row.title.label].enabled = true;
                    row.enabled.label = _("On");
                }
                notification.set_string(
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
                notification.get_string("applications")
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

        notification.set_string(
            "applications",
            JSON.stringify(this._notification_apps)
        );
    },

    /**
     * Sharing Settings
     * TODO: use supported capabilities & gsettings
     */
    _sharingSettings: function () {
        // Battery
        if (this.device.get_action_enabled("reportStatus")) {
            let battery = this.device._plugins.get("battery");
            mapBoolFlag(this._getSettings("battery"), "allow", this.battery_allow, 2);
        } else {
            this.battery_allow.get_parent().get_parent().visible = false;
        }

        // Clipboard Sync
        let clipboard = this.device._plugins.get("clipboard");
        mapAllow(this._getSettings("clipboard"), "allow", this.clipboard_allow);

        // Direct Share
        let share = this.device._plugins.get("share");
        mapBoolFlag(this._getSettings("share"), "allow", this.share_allow, 4);

        // Media Players
        let mpris = this.device._plugins.get("mpris");
        mapBoolFlag(this._getSettings("mpris"), "allow", this.mpris_allow, 4);

        // Mouse & Keyboard input
        let mousepad = this.device._plugins.get("mousepad");
        mapBoolFlag(this._getSettings("mousepad"), "allow", this.mousepad_allow, 4);

        // Location Sharing
        let findmyphone = this.device._plugins.get("findmyphone");
        mapBoolFlag(this._getSettings("findmyphone"), "allow", this.findmyphone_allow, 4);

        // Separators & Sorting
        this.sharing_list.set_header_func(section_separators);

        this.sharing_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
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
                summary: row.meta.summary,
                transient_for: this.get_toplevel()
            });

            dialog.connect("response", (dialog, response) => {
                // Set
                if (response === Gtk.ResponseType.OK) {
                    this._keybindings[row.name] = dialog.accelerator;
                // Reset (Backspace)
                } else if (response === 1) {
                    this._keybindings[row.name] = "";
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
        icon: "smartphone",
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

