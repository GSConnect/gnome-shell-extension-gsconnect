"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Keybindings = imports.modules.keybindings;


function template_connect_func(builder, obj, signalName, handlerName, connectObj, flags) {
    obj.connect(signalName, connectObj[handlerName].bind(connectObj));
};


function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


function switcher_separators(row, before) {
    if (before && row.type !== before.type) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


// FIXME: this is garbage
function mapWidget(settings, widget, map) {
    let row = widget.get_parent().get_parent();
    row.visible = (settings);

    // Init the widget
    let value = settings.get_uint("allow");
    widget.label = (map.get(value) !== undefined) ? map.get(value) : value.toString();

    // Watch settings for changes
    let _changed = settings.connect("changed::allow", () => {
        let value = settings.get_uint("allow");
        widget.label = (map.get(value) !== undefined) ? map.get(value) : value.toString();
    });
    widget.connect_after("destroy", () => settings.disconnect(_changed));

    // Watch the Gtk.ListBox for activation
    row.get_parent().connect("row-activated", (box, arow) => {
        if (row === arow) {
            let currentValue = settings.get_uint("allow");
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

            settings.set_uint("allow", newValue);
        }
    });
};


function mapFlagToBool(settings, label, on) {
    let row = label.get_parent().get_parent();
    row.visible = (settings);

    if (settings) {
        // Set the intial label
        label.label = (settings.get_uint("allow") & on) ? _("On") : _("Off");

        // Watch settings for changes
        let _changed = settings.connect("changed::allow", () => {
            label.label = (settings.get_uint("allow") & on) ? _("On") : _("Off");
        });
        label.connect_after("destroy", () => settings.disconnect(_changed));

        // Watch the Gtk.ListBox for activation
        row.get_parent().connect("row-activated", (box, arow) => {
            if (row === arow) {
                settings.set_uint("allow", settings.get_uint("allow") ^ on);
            }
        });
    }
};


function mapBoolLabel(settings, key, label) {
    let row = label.get_parent().get_parent();
    row.visible = (settings);

    if (settings) {
        // Set the intial label
        label.label = settings.get_boolean(key) ? _("On") : _("Off");

        // Watch settings for changes
        let _changed = settings.connect("changed::" + key, () => {
            label.label = settings.get_boolean(key) ? _("On") : _("Off");
        });
        label.connect_after("destroy", () => settings.disconnect(_changed));

        // Watch the Gtk.ListBox for activation
        row.get_parent().connect("row-activated", (box, arow) => {
            if (row === arow) {
                settings.set_boolean(key, !settings.get_boolean(key));
            }
        });
    }
};


function mapAllow(settings, label) {
    let map = new Map([
        [1, _("Off")],
        [2, _("To Device")],
        [4, _("From Device")],
        [6, _("Both")]
    ]);

    return mapWidget(settings, label, map);
};


Gio.Settings.prototype.bind_with_mapping = function(key, object, property, flags=0, get_mapping, set_mapping) {
    let type = "";

    if ((flags & Gio.SettingsBindFlags.GET) || flags === 0) {
        let _changed = this.connect(
            "changed::" + key,
            () => get_mapping(this.get_value(key))
        );
        object.connect("destroy", () => this.disconnect(_changed));
    }

    if ((flags & Gio.SettingsBindFlags.SET) || flags === 0) {
        let _changed = object.connect(
            "notify::" + property,
            () => set_mapping(object[property])
        );
        object.connect("destroy", () => object.disconnect(_changed));
    }
};


function mapSwitch(settings, widget, [on, off]=[6, 4]) {
    return;
    settings.bind_with_mapping(
        "allow",
        widget,
        "active",
        0,
        variant => { widget.active = (variant.unpack() === on); },
        value => settings.set_uint("allow", (value) ? on : off)
    );
};


/**
 * A simple dialog for selecting a device
 */
var DeviceChooser = GObject.registerClass({
    GTypeName: "GSConnectDeviceChooser"
}, class DeviceChooserDialog extends Gtk.Dialog {

    _init(params) {
        super._init({
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
    }

    _populate(devices) {
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
var SidebarRow = GObject.registerClass({
    GTypeName: "GSConnectSidebarRow"
}, class SidebarRow extends Gtk.ListBoxRow {

    _init(params) {
        super._init({
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
        if (params.show_go_next) {
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
var SectionRow = GObject.registerClass({
    GTypeName: "GSConnectSectionRow"
}, class SidebarRow extends Gtk.ListBoxRow {

    _init(params) {
        let icon_name = params.icon_name;
        let title = params.title;
        let subtitle = params.subtitle;
        let widget = params.widget;
        delete params.icon_name;
        delete params.title;
        delete params.subtitle;
        delete params.widget;

        super._init(Object.assign({
            activatable: true,
            selectable: false,
            height_request: 56,
            visible: true
        }, params));

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


var SettingsWindow = GObject.registerClass({
    GTypeName: "GSConnectSettingsWindow",
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/settings.ui",
    Children: [
        "headerbar",
        "headerbar-title", "headerbar-subtitle", "headerbar-edit", "headerbar-entry",
        "prev-button",
        "stack", "switcher", "sidebar",
        "shell-list",
        "show-indicators", "show-offline", "show-unpaired", "show-battery",
        "extensions-list",
        "files-integration", "webbrowser-integration",
        "advanced-list",
        "debug-mode", "debug-window",
        "help", "help-list"
    ]
}, class SettingsWindow extends Gtk.ApplicationWindow {

    _init() {
        Gtk.Widget.set_connect_func.call(this, template_connect_func);

        super._init({
            application: Gio.Application.get_default(),
            visible: true
        });

        // Header Bar
        this.headerbar_title.label = this.application.name;
        this.headerbar_subtitle.label = null;

        // Sidebar
        this.help.type = "device";
        this.switcher.set_header_func(switcher_separators);
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
        this._serviceDevices = this.application.connect(
            "notify::devices",
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();

        // Cleanup
        this.connect("destroy", () => {
            GLib.source_remove(this._refreshSource);
            this.application.disconnect(this._serviceDevices);
        });
    }

    /**
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        this.headerbar_title.label = this.application.name;
        this.headerbar_subtitle.visible = false;
        this.headerbar_edit.visible = true;
        this.sidebar.set_visible_child_name("switcher");

        this.switcher.get_row_at_index(0).emit("activate");
        button.visible = false;
    }

    _onEditServiceName(button, event) {
        this.headerbar_entry.text = this.application.name;
        this.headerbar_entry.visible = true;
        this.headerbar_title.visible = false;
        this.headerbar_edit.visible = false;
    }

    _onSetServiceName(button, event) {
        this.application.name = this.headerbar_entry.text;
        this.headerbar_title.label = this.application.name;

        this.headerbar_entry.visible = false;
        this.headerbar_title.visible = true;
        this.headerbar_edit.visible = true;
    }

    /**
     * Context Switcher
     */
    _onSwitcherRowSelected(box, row) {
        // I guess this is being called before the template children are ready
        if (!this.stack) { return; }

        row = row || this.switcher.get_row_at_index(0);
        let name = row.get_name() || null;

        this.stack.set_visible_child_name(name);

        if (this.sidebar.get_child_by_name(name)) {
            this.headerbar_title.label = row.title.label;
            this.headerbar_subtitle.label = this.stack.get_visible_child().device_type.label;
            this.headerbar_subtitle.visible = true;
            this.headerbar_edit.visible = false;

            this.sidebar.set_visible_child_name(name);
            this.prev_button.visible = true;
        }
    }

    /**
     * UI Setup and template connecting
     */
    _bindSettings() {
        // Shell
        mapBoolLabel(gsconnect.settings, "show-indicators", this.show_indicators);
        mapBoolLabel(gsconnect.settings, "show-offline", this.show_offline);
        mapBoolLabel(gsconnect.settings, "show-unpaired", this.show_unpaired);
        mapBoolLabel(gsconnect.settings, "show-battery", this.show_battery);
        this.shell_list.set_header_func(section_separators);

        // Extensions
        // TODO: these should go..
        mapBoolLabel(gsconnect.settings, "nautilus-integration", this.files_integration);
        mapBoolLabel(gsconnect.settings, "webbrowser-integration", this.webbrowser_integration);
        this.extensions_list.set_header_func(section_separators);

        // Application Extensions
        mapBoolLabel(gsconnect.settings, "debug", this.debug_mode);
        this.debug_window.connect("clicked", () => {
            GLib.spawn_command_line_async(
                'gnome-terminal ' +
                '--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ' +
                '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
            );
        });
        this.advanced_list.set_header_func(section_separators);
    }

    _onDevicesChanged() {
        for (let dbusPath of this.application.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(dbusPath);
            }
        }

        this.stack.foreach(child => {
            if (child.row) {
                let name = child.row.get_name();
                if (this.application.devices.indexOf(name) < 0) {
                    this.stack.get_child_by_name(name).destroy();
                }
            }
        });

        this.help.visible = !this.application.devices.length;
    }

    addDevice(dbusPath) {
        let device = this.application._devices.get(dbusPath);

        // Create a new device widget
        let panel = new DeviceSettings(device);

        // Add device to switcher, and panel stack
        this.stack.add_titled(panel, dbusPath, device.name);
        this.sidebar.add_named(panel.switcher, dbusPath);
        this.switcher.add(panel.row);
    }
});


var DeviceSettings = GObject.registerClass({
    GTypeName: "GSConnectDeviceSettings",
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/device.ui",
    Children: [
        "switcher",
        // Device
        "device-icon", "device-name", "device-type",
        "battery-level", "battery-percent", "battery-condition",
        "device-status-list",
        "device-connected", "device-connected-image", "device-connected-text",
        "device-paired", "device-paired-image", "device-paired-text",
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
    ]
}, class DeviceSettings extends Gtk.Stack {

    _init(device) {
        Gtk.Widget.set_connect_func.call(this, template_connect_func);

        super._init();

        this.service = Gio.Application.get_default();
        this.device = device;
        this.meta = DeviceMetadata[this.device.type];

        this._gsettings = {};

        this.row = new SidebarRow({
            icon_name: (device.paired) ? this.meta.symbolic_icon : this.meta.unpaired_icon,
            title: device.name,
            type: "device",
            name: device._dbus.get_object_path(),
            show_go_next: true
        });

        // Info Page
        this.device.bind_property(
            "name",
            this.device_name,
            "label",
            GObject.BindingFlags.SYNC_CREATE
        );
        this.device_type.label = this.meta.type;
        this.device_icon.icon_name = this.meta.icon;

        // Connected
        this._connectedId = this.device.connect(
            "notify::connected",
            this._onConnected.bind(this)
        );
        this._onConnected();

        // Paired
        this._pairedId = this.device.connect(
            "notify::paired",
            this._onPaired.bind(this)
        );
        this._onPaired();

        this.device_status_list.set_header_func(section_separators);

        this._batteryBar();
        this._sharingSettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._eventsSettings();
        this._keyboardShortcuts();

        // Cleanup
        this.connect_after("destroy", () => {
            this.device.disconnect(this._connectedId);
            this.device.disconnect(this._pairedId);

            this.switcher.destroy();
            this.row.destroy();

            if (this._infoBattery) {
                this.device._plugins.get("battery").disconnect(this._infoBattery);
            }
        });
    }

    _getSettings(name) {
        if (this._gsettings[name]) {
            return this._gsettings[name];
        }

        if (this.device.supportedPlugins().indexOf(name) > -1) {
            let meta = imports.service.plugins[name].Metadata;

            this._gsettings[name] = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(meta.id, -1),
                path: gsconnect.settings.path + ["device", this.device.id, "plugin", name, ""].join("/")
            });
        }

        return this._gsettings[name] || false;
    }

    _onSwitcherRowSelected(box, row) {
        this.set_visible_child_name(row.get_name());
    }

    _onConnected() {
        if (this.device.connected) {
            this.device_connected_image.icon_name = "emblem-ok-symbolic";
            this.device_connected_text.label = _("Device is connected");
            this.device_connected.set_tooltip_markup(null);
        } else {
            this.device_connected_image.icon_name = "emblem-synchronizing-symbolic";
            this.device_connected_text.label = _("Device is disconnected");
            this.device_connected.set_tooltip_markup(
                // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                _("Reconnect <b>%s</b>").format(this.device.name)
            );
        }

        this.device_paired.sensitive = this.device.connected;
    }

    _onPaired() {
        if (this.device.paired) {
            this.device_paired_image.icon_name = "application-certificate-symbolic";
            this.device_paired_text.label = _("Device is paired");
            this.device_paired.set_tooltip_markup(
                // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                _("Unpair <b>%s</b>").format(this.device.name)
            );

            this.row.icon.icon_name = this.meta.symbolic_icon;
        } else {
            this.device_paired_image.icon_name = "channel-insecure-symbolic";
            this.device_paired_text.label = _("Device is unpaired");
            this.device_paired.set_tooltip_markup(
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
                _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(
                    this.device.name,
                    this.device.fingerprint,
                    this.service.fingerprint
                )
            );

            this.row.icon.icon_name = this.meta.unpaired_icon;
        }
    }

    /**
     * Info Page
     */
    _batteryBar() {
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
            battery.connect_after("destroy", () => {
                this.battery_level.visible = false;
                this.battery_condition.visible = false;
                this.battery_percent.visible = false;
            });
        }
    }

    /**
     * RunCommand Page
     * TODO: maybe action<->commands?
     */
    _runcommandSettings() {
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
    }

    _insertCommand(uuid) {
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
    }

    _newCommand(box, row) {
        if (row === this.command_new) {
            let uuid = GLib.uuid_string_random();
            this._commands[uuid] = { name: "", command: "" };
            this._editCommand(this._insertCommand(uuid), uuid);
        }
    }

    _populateCommands() {
        this.command_list.foreach(row => {
            if (row !== this.command_new && row !== this.command_editor) {
                row.destroy();
            }
        });

        for (let uuid in this._commands) {
            this._insertCommand(uuid);
        }
    }

    _saveCommand() {
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
    }

    _resetCommandEditor(button) {
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
    }

    _editCommand(row, uuid) {
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
    }

    _browseCommand(entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type("application/x-executable");
        let dialog = new Gtk.FileChooserDialog({ filter: filter });
        dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        dialog.add_button(_("Open"), Gtk.ResponseType.OK);

        if (dialog.run() === Gtk.ResponseType.OK) {
            this.command_line.text = dialog.get_filename();
        }

        dialog.destroy();
    }

    _removeCommand(button) {
        delete this._commands[this.command_editor.uuid];
        this._getSettings("runcommand").set_value(
            "command-list",
            gsconnect.full_pack(this._commands)
        );

        this._resetCommandEditor();
        this._populateCommands();
    }

    /**
     * Notification Settings
     */
    _notificationSettings() {
        let notification = this._getSettings("notification");

        if (notification) {
            mapSwitch(notification, this.notification_allow, [ 6, 4 ]);

            // Populate, sort and separate
            this._populateApplications(notification);
            this.notification_apps.set_sort_func((row1, row2) => {
                return row1.title.label.localeCompare(row2.title.label);
            });
            this.notification_apps.set_header_func(section_separators);

            this.notification_allow.bind_property(
                "active",
                this.notification_apps,
                "sensitive",
                GObject.BindingFlags.SYNC_CREATE
            );
        } else {
            this.notification.visible = false;
        }
    }

    _onNotificationRowActivated(box, row) {
        let notification = this._getSettings("notification");

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
    }

    _populateApplications(notification) {
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
    }

    _queryApplications(notification) {
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
    }

    /**
     * Sharing Settings
     * TODO: use supported capabilities & gsettings
     */
    _sharingSettings() {
        // Battery
        if (this.device.get_action_enabled("reportStatus")) {
            mapFlagToBool(this._getSettings("battery"), this.battery_allow, 2);
        } else {
            this.battery_allow.get_parent().get_parent().visible = false;
        }

        //mapAllow(this._getSettings("clipboard"), this.clipboard_allow);
        mapFlagToBool(this._getSettings("share"), this.share_allow, 4);
        mapFlagToBool(this._getSettings("mpris"), this.mpris_allow, 4);
        mapFlagToBool(this._getSettings("mousepad"), this.mousepad_allow, 4);
        mapFlagToBool(this._getSettings("findmyphone"), this.findmyphone_allow, 4);

        // Separators & Sorting
        this.sharing_list.set_header_func(section_separators);

        this.sharing_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
    }

    /**
     * Keyboard Shortcuts
     */
    _keyboardShortcuts() {
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

        this.shortcuts_list.set_header_func(section_separators);
    }

    _onShortcutRowActivated(box, row) {
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
    }
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

