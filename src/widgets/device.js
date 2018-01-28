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
const Sound = imports.sound;


var SectionRow = new Lang.Class({
    Name: "GSConnectSectionRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params) {
        let icon_name = params.icon_name || "";
        delete params.icon_name;
        let title = params.title;
        delete params.title;
        let subtitle = params.subtitle;
        delete params.subtitle;

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
    }
});


var KeybindingsSection = new Lang.Class({
    Name: "GSConnectKeybindingsSection",
    Extends: Gtk.Frame,

    _init: function (device) {
        this.parent({
            can_focus: false,
            hexpand: true,
            shadow_type: Gtk.ShadowType.IN,
            visible: true
        });

        this.device = device;

        this.keyView = new KeybindingsWidget.TreeView(
            this.device.settings,
            "keybindings"
        );
        this.add(this.keyView);

        this._setup();
    },

    _reset: function () {
        this.device.settings.set_string("keybindings", "{}");
        this.remove(this.keyView);
        this.keyView.destroy();
        delete this.keyView;

        this.keyView = new KeybindingsWidget.TreeView(
            this.device.settings,
            "keybindings"
        );
        this.add(this.keyView);

        //this.keyView.model.clear();
        this._setup();
    },

    _setup: function () {
        // TRANSLATORS: Open the device menu
        this.keyView.addAccel("menu", _("Open Menu"), 0, 0);
        // TRANSLATORS: Open a new SMS window
        this.keyView.addAccel("sms", _("Send SMS"), 0, 0);
        // TRANSLATORS: eg. Locate Google Pixel
        this.keyView.addAccel("find", _("Locate %s").format(this.device.name), 0, 0);
        // TRANSLATORS: Open the device's list of browseable directories
        this.keyView.addAccel("browse", _("Browse Files"), 0, 0);
        // TRANSLATORS: Open the file chooser for sending files/links
        this.keyView.addAccel("share", _("Share File/URL"), 0, 0);

        this.keyView.setAccels(
            JSON.parse(this.device.settings.get_string("keybindings"))
        );
    }
});


const DoubleBool = {
    OFF: 1,
    OUT: 2,
    IN: 4
};


var Settings = Lang.Class({
    Name: "GSConnectDeviceSettings",
    Extends: Gtk.Grid,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/device.ui",
    Children: [
        "stack", "switcher",
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
        "send-notifications", "notification-apps",
        // Sharing
        "sharing", "sharing-page", "sharing-list",
        "send-statistics", "direct-sharing", "clipboard-sync", "mpris-control", "allow-input",
        "automount",
        // Telephony
        "telephony", "telephony-page",
        "handler-list", "handle-messaging", "handle-calls",
        "ringing-list", "ringing-volume", "ringing-pause",
        "talking-list", "talking-volume", "talking-pause", "talking-microphone"
    ],

    _init: function (daemon, device) {
        this.parent();

        this.daemon = daemon;
        this.device = device;

        this.switcher.connect("row-selected", (box, row) => {
            this.stack.set_visible_child_name(row.get_name());
        });

        this._infoPage();
        this._batterySettings();
        this._commandsSettings();
        this._notificationSettings();
        this._sharingSettings();
        this._telephonySettings();
    },

    // FIXME FIXME FIXME
    _addPrefs: function () {
        develSection.addGSetting(ext.settings, "debug");
        ext.settings.connect("changed::debug", () => {
            if (ext.settings.get_boolean("debug")) {
                GLib.spawn_command_line_async(
                    'gnome-terminal --tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" --tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
                );
            }
        });
    },

    _sectionSeparators: function (row, before) {
        if (before) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    _bool_image: function (obj, key, image, on_off) {
        if (obj && obj.settings) {
            let [on, off] = on_off;
            // Watch the setting for changes
            obj.settings.connect("changed::" + key, (settings) => {
                image.icon_name = settings.get_boolean(key) ? on : off;
            });
            // Init the label
            image.icon_name = obj.settings.get_boolean(key) ? on : on;

            // Watch the Gtk.ListBox for activation
            let row = label.get_parent().get_parent();
            let box = row.get_parent();

            box.connect("row-activated", (box, arow) => {
                if (row === arow) {
                    // Set the boolean to the inverse of the label "value"
                    obj.settings.set_boolean(key, (label.label === off));
                }
            });
        } else {
            label.get_parent().get_parent().sensitive = false;
        }
    },

    _bind_bool: function (obj, key, label) {
        if (obj && obj.settings) {
            // Watch the setting for changes
            obj.settings.connect("changed::" + key, (settings) => {
                label.label = settings.get_boolean(key) ? _("On") : _("Off");
            });
            // Init the label
            label.label = obj.settings.get_boolean(key) ? _("On") : _("Off");

            // Watch the Gtk.ListBox for activation
            let row = label.get_parent().get_parent();
            let box = row.get_parent();

            box.connect("row-activated", (box, arow) => {
                if (row === arow) {
                    // Set the boolean to the inverse of the label "value"
                    obj.settings.set_boolean(key, (label.label === _("Off")));
                }
            });
        } else {
            label.get_parent().get_parent().sensitive = false;
        }
    },

    _bind_dbool: function (settings, key, label) {
        settings.connect("changed::" + key, (settings) => {
            let flags = settings.get_flags(key);

            if (flags === DoubleBool.IN) {
                label.label = _("In");
            } else if (flags === DoubleBool.OUT) {
                label.label = _("Out");
            } else if (flags & (DoubleBool.OUT | DoubleBool.IN)) {
                label.label = _("On");
            } else {
                label.label = _("Off");
            }
        });
        settings.emit("changed::" + key, key);

        // Watch the Gtk.ListBox for activation
        let row = label.get_parent().get_parent();
        let box = row.get_parent();

        box.connect("row-activated", (box, arow) => {
            if (row === arow) {
                let val;

                switch (label.label) {
                    case _("On"):
                        val = DoubleBool.OFF;
                        break;
                    case _("Off"):
                        val = DoubleBool.IN;
                        break;
                    case _("In"):
                        val = DoubleBool.OUT;
                        break;
                    case _("Out"):
                        val = DoubleBool.OUT | DoubleBool.IN;
                        break;
                    default:
                        throw Error("unknown value");
                }

                settings.set_flags(key, val);
            }
        });
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
            }
        });
        this.device.notify("paired");
        this.device_status_list.set_header_func(this._sectionSeparators);
    },

    /**
     * Battery Settings
     */
    _batterySettings: function () {
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

    _commandsSettings: function () {
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
            this.command_edit_cancel.connect("clicked", () => this._cancelCommand());
            this.command_edit_apply.connect("clicked", () => this._applyCommand());
            this.command_edit_command.connect("icon-release", () => this._openCommand());

            // Local Command List
            let commands = runcommand.settings.get_string("command-list");
            this._commands = JSON.parse(commands);

            this.runcommand_local_list.set_sort_func((row1, row2) => {
                if (row1.get_child() instanceof Gtk.Image) {
                    return 1;
                } else if (row2.get_child() instanceof Gtk.Image) {
                    return -1;
                } else if (row1.uuid && row1.uuid === row2.get_name()) {
                    return 1;
                } else if (row2.uuid && row2.uuid === row1.get_name()) {
                    return -1;
                } else if (!row1.title || !row2.title) {
                    return 0;
                }

                return row1.title.label.localeCompare(row2.title.label);
            });
            this.runcommand_local_list.set_header_func(this._sectionSeparators);
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
            let dialog = new Gtk.FileChooserDialog({
                action: Gtk.FileChooserAction.OPEN,
                filter: filter
            });
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
            notification.settings.bind(
                "send-notifications",
                this.send_notifications,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this._populateApplications(notification);
            this.notification_apps.set_sort_func((row1, row2) => {
                return row1.title.label.localeCompare(row2.title.label);
            });
            this.notification_apps.set_header_func(this._sectionSeparators);
            this.notification_apps.connect("row-activated", (box, row) => {
                if (row.enabled.label === _("On")) {
                    this._notification_apps[row.appName.label].enabled = false;
                    row.enabled.label = _("Off")
                } else {
                    this._notification_apps[row.appName.label].enabled = true;
                    row.enabled.label = _("On")
                }
                notification.settings.set_string(
                    "applications",
                    JSON.stringify(this._notification_apps)
                );
            });
            notification.settings.bind(
                "send-notifications",
                this.notification_apps,
                "sensitive",
                Gio.SettingsBindFlags.DEFAULT
            );
        } else {
            this.notification.visible = false;
            this.notification_page.visible = false;
        }
    },

    _populateApplications: function (notification) {
        let applications = this._queryApplications(notification);

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
        let applications = notification.settings.get_string("applications");
        this._notification_apps = JSON.parse(applications);

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
                let name = appInfo.get_name();

                if (!this._notification_apps[name]) {
                    this._notification_apps[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        // Include applications that statically declare to show notifications
        for (let appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_boolean("X-GNOME-UsesNotifications")) {
                let name = appInfo.get_name();

                if (!this._notification_apps[name]) {
                    this._notification_apps[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        notification.settings.set_string(
            "applications",
            JSON.stringify(this._notification_apps)
        );

        return applications;
    },

    /**
     * Sharing Settings
     */
    _sharingSettings: function () {
        // Battery
        let battery = this.device._plugins.get("battery");
        this._bind_bool(battery, "send-statistics", this.send_statistics);

        // Direct Share
        let share = this.device._plugins.get("share");
        this._bind_bool(share, "direct-sharing", this.direct_sharing);

        // Clipboard Sync
        let clipboard = this.device._plugins.get("clipboard");
        this._bind_dbool(clipboard.settings, "clipboard-sync", this.clipboard_sync);

        // Media Players
        let mpris = this.device._plugins.get("mpris");
        this._bind_bool(mpris, "mpris-control", this.mpris_control);

        // Mouse & Keyboard input
        let mousepad = this.device._plugins.get("mousepad");
        this._bind_bool(mousepad, "allow-input", this.allow_input);

        // SFTP
        let sftp = this.device._plugins.get("sftp");
        this._bind_bool(sftp, "automount", this.automount);

        // row separators
        this.sharing_list.set_header_func(this._sectionSeparators);

//        this.sharing_list.set_sort_func((row1, row2) => {
//            return row1.appName.label.localeCompare(row2.appName.label);
//        });
    },

    /**
     * Telephony Settings
     */
    _telephonySettings: function () {
        let telephony = this.device._plugins.get("telephony");

        if (telephony) {
            // Event Handling
            this._bind_bool(telephony, "handle-messaging", this.handle_messaging);
            this._bind_bool(telephony, "handle-calls", this.handle_calls);
            this.handler_list.set_header_func(this._sectionSeparators);

            // Ringing Event
            telephony.settings.bind(
                "ringing-volume",
                this.ringing_volume,
                "active-id",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "ringing-pause",
                this.ringing_pause,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this.ringing_list.set_header_func(this._sectionSeparators);

            // Talking Event
            telephony.settings.bind(
                "talking-volume",
                this.talking_volume,
                "active-id",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "talking-microphone",
                this.talking_microphone,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "talking-pause",
                this.talking_pause,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this.talking_list.set_header_func(this._sectionSeparators);
        } else {
            this.telephony.visible = false;
            this.telephony_page.visible = false;
        }

        //
        if (this.device.plugins.indexOf("mpris") < 0) {
            this.ringing_pause.sensitive = false;
            this.ringing_pause.set_tooltip_markup(
                _("MPRIS not supported")
            );

            this.talking_pause.sensitive = false;
            this.talking_pause.set_tooltip_markup(
                _("MPRIS not supported")
            );
        }

        //
        if (!Sound._mixerControl) {
            this.ringing_volume.sensitive = false;
            this.ringing_volume.set_tooltip_markup(_("Gvc not available"));

            this.talking_volume.sensitive = false;
            this.talking_volume.set_tooltip_markup(_("Gvc not available"));

            this.talking_microphone.sensitive = false;
            this.talking_microphone.set_tooltip_markup(_("Gvc not available"));
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

