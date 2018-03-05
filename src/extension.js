"use strict";

const Lang = imports.lang;

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

// Local Imports
window.gsconnect = {
    datadir: imports.misc.extensionUtils.getCurrentExtension().path
};

imports.searchPath.push(gsconnect.datadir);
const _bootstrap = imports._bootstrap;
const _ = gsconnect._;
const Actors = imports.actors;
const DBus = imports.modules.dbus;


/** ... FIXME FIXME FIXME */
var DoNotDisturbItem = new Lang.Class({
    Name: "GSConnectShellDoNotDisturbItem",
    Extends: PopupMenu.PopupSwitchMenuItem,

    _init: function (daemon, device) {
        this.parent(_("Do Not Disturb"), false);

        // Update the toggle state when 'paintable'
        this.actor.connect("notify::mapped", () => {
            let now = GLib.DateTime.new_now_local().to_unix();
            this.setToggleState(gsconnect.settings.get_int("donotdisturb") > now);
        });

        this.connect("toggled", () => {
            // The state has already been changed when this is emitted
            if (this.state) {
                let dialog = new DoNotDisturbDialog();
                dialog.open();
            } else {
                gsconnect.settings.set_int("donotdisturb", 0);
            }

            this._getTopMenu().close(true);
        });
    }
});


var DoNotDisturbDialog = new Lang.Class({
    Name: "GSConnectShellDoNotDisturbDialog",
    Extends: Actors.Dialog,

    _init: function () {
        this.parent({
            icon: "preferences-system-notifications-symbolic",
            title: _("Do Not Disturb"),
            subtitle: _("Silence Mobile Device Notifications")
        });

        //
        this._time = 1*60*60; // 1 hour in seconds

        this.permButton = new Actors.RadioButton({
            text: _("Until you turn this off")
        });
        this.content.add(this.permButton);

        // Duration Timer
        this.timerWidget = new St.BoxLayout({
            vertical: false,
            x_expand: true
        });

        let now = GLib.DateTime.new_now_local();
        this.timerLabel = new St.Label({
            text: _("Until %s (%s)").format(
                Util.formatTime(now.add_seconds(this._time)),
                this._getDurationLabel()
            ),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: "margin-right: 6px;"
        });
        this.timerWidget.add_child(this.timerLabel);

        this.minusTime = new St.Button({
            style_class: "pager-button",
            child: new St.Icon({
                icon_name: "list-remove-symbolic",
                icon_size: 16
            })
        });
        this.minusTime.connect("clicked", () => this._minusTime());
        this.timerWidget.add_child(this.minusTime);

        this.plusTime = new St.Button({
            style_class: "pager-button",
            child: new St.Icon({
                icon_name: "list-add-symbolic",
                icon_size: 16
            })
        });
        this.plusTime.connect("clicked", () => this._plusTime());
        this.timerWidget.add_child(this.plusTime);

        this.timerButton = new Actors.RadioButton({
            widget: this.timerWidget,
            group: this.permButton.group,
            active: true
        });
        this.content.add(this.timerButton);

        // Dialog Buttons
        this.setButtons([
            { label: _("Cancel"), action: () => this._cancel(), default: true },
            { label: _("Done"), action: () => this._done() }
        ]);
    },

    _cancel: function () {
        gsconnect.settings.set_int("donotdisturb", 0);
        this.close();
    },

    _done: function () {
        let time;

        if (this.timerButton.active) {
            let now = GLib.DateTime.new_now_local();
            time = now.add_seconds(this._time).to_unix();
        } else {
            time = GLib.MAXINT32;
        }

        gsconnect.settings.set_int("donotdisturb", time);
        this.close();
    },

    _minusTime: function () {
        if (this._time <= 60*60) {
            this._time -= 15*60;
        } else {
            this._time -= 60*60;
        }

        this._setTimeLabel();
    },

    _plusTime: function () {
        if (this._time < 60*60) {
            this._time += 15*60;
        } else {
            this._time += 60*60;
        }

        this._setTimeLabel();
    },

    _getDurationLabel: function () {
        if (this._time >= 60*60) {
            let hours = this._time / 3600;
            return Gettext.ngettext("%d Hour", "%d Hours", hours).format(hours);
        } else {
            return _("%d Minutes").format(this._time / 60);
        }
    },

    _setTimeLabel: function () {
        this.minusTime.reactive = (this._time > 15*60);
        this.plusTime.reactive = (this._time < 12*60*60);

        let now = GLib.DateTime.new_now_local();
        this.timerLabel.text = _("Until %s (%s)").format(
            Util.formatTime(now.add_seconds(this._time)),
            this._getDurationLabel()
        );
    }
});


/** A PopupMenu used as an information and control center for a device */
var DeviceMenu = new Lang.Class({
    Name: "GSConnectShellDeviceMenu",
    Extends: PopupMenu.PopupMenuSection,

    _init: function (daemon, device) {
        this.parent();

        this.device = device;
        this.daemon = daemon;
        this._keybindings = [];

        // Device Box
        this.deviceBox = new PopupMenu.PopupBaseMenuItem({
            can_focus: false,
            reactive: false,
            style_class: "popup-menu-item gsconnect-device-box"
        });
        this.deviceBox.actor.remove_child(this.deviceBox._ornamentLabel);
        this.deviceBox.actor.vertical = false;
        this.addMenuItem(this.deviceBox);

        this.deviceButton = new Actors.DeviceButton(object, iface);
        this.deviceBox.actor.add_child(this.deviceButton);

        this.controlBox = new St.BoxLayout({
            style_class: "gsconnect-control-box",
            vertical: true,
            x_expand: true
        });
        this.deviceBox.actor.add_child(this.controlBox);

        // Title Bar
        this.nameBar = new St.BoxLayout({
            style_class: "gsconnect-title-bar"
        });
        this.controlBox.add_child(this.nameBar);

        this.nameLabel = new St.Label({
            style_class: "gsconnect-device-name",
            text: this.device.name
        });
        this.nameBar.add_child(this.nameLabel);

        let nameSeparator = new St.Widget({
            style_class: "popup-separator-menu-item gsconnect-title-separator",
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.nameBar.add_child(nameSeparator);

        this.deviceBattery = new ShellWidget.DeviceBattery(this.device);
        this.nameBar.add_child(this.deviceBattery);

        // Plugin Bar
        this.pluginBar = new St.BoxLayout({
            style_class: "gsconnect-plugin-bar"
        });
        this.controlBox.add_child(this.pluginBar);

        this.telephonyButton = new ShellWidget.PluginButton({
            icon_name: "sms-symbolic",
            callback: Lang.bind(this, this._telephonyAction),
            tooltip_text: _("Send SMS")
        });
        this.pluginBar.add_child(this.telephonyButton);

        this.findmyphoneButton = new ShellWidget.PluginButton({
            icon_name: "find-location-symbolic",
            callback: Lang.bind(this, this._findmyphoneAction),
            tooltip_text: _("Locate %s").format(this.device.name)
        });
        this.pluginBar.add_child(this.findmyphoneButton);

        this.sftpButton = new ShellWidget.PluginButton({
            icon_name: "folder-remote-symbolic",
            callback: Lang.bind(this, this._sftpAction),
            toggle_mode: true,
            tooltip_text: _("Browse Files")
        });
        this.pluginBar.add_child(this.sftpButton);

        this.shareButton = new ShellWidget.PluginButton({
            icon_name: "send-to-symbolic",
            callback: Lang.bind(this, this._shareAction),
            tooltip_text: _("Share File/URL")
        });
        this.pluginBar.add_child(this.shareButton);

        this.runcommandButton = new ShellWidget.PluginButton({
            icon_name: "system-run-symbolic",
            callback: Lang.bind(this, this._runcommandAction),
            toggle_mode: true,
            tooltip_text: _("Run Commands")
        });
        this.pluginBar.add_child(this.runcommandButton);

        this.mousepadButton = new ShellWidget.PluginButton({
            icon_name: "input-keyboard-symbolic",
            callback: Lang.bind(this, this._mousepadAction),
            toggle_mode: true,
            tooltip_text: _("Remote Input")
        });
        this.pluginBar.add_child(this.mousepadButton);

        // Status Bar
        this.statusBar = new St.BoxLayout({
            style_class: "gsconnect-status-bar",
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true
        });
        this.controlBox.add_child(this.statusBar);

        this.statusLabel = new St.Label({
            text: "",
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.add_child(this.statusLabel);

        // List Panel
        this.listPanel = new PopupMenu.PopupMenuSection();
        this.listPanel.actor.style_class = "popup-sub-menu";
        this.listPanel.actor.visible = false;
        this.listPanel._getTopMenu().connect("open-state-changed", (actor, open) => {
            if (!open) {
                this.sftpButton.checked = false;
                this.runcommandButton.checked = false;
                this.listPanel.actor.visible = false;
            }
        });
        this.addMenuItem(this.listPanel);

        // Properties
        this.device.connect("notify", this._sync.bind(this));
        this.device.connect("destroy", () => this.destroy());
        this.device.actions.connect("action-enabled-changed", this._sync.bind(this));
        this.device.actions.connect("action-added", this._sync.bind(this));
        this.device.actions.connect("action-removed", this._sync.bind(this));

        this.actor.connect("notify::visible", this._sync.bind(this));
        this._settingsChanged = gsconnect.settings.connect("changed", this._sync.bind(this));

        this._sync(this.device);
    },

    _sync: function (device) {
        debug(this.device.name);

        if (!this.actor.visible) { return; }

        let { connected, paired, plugins } = this.device;

        // Title Bar
        // Fix for "st_label_set_text: assertion 'text != NULL' failed"
        this.nameLabel.text = this.device.name || "";

        if (connected && paired && gsconnect.settings.get_boolean("show-battery")) {
            this.deviceBattery.visible = true;
            this.deviceBattery.update();
        } else {
            this.deviceBattery.visible = false;
        }

        // Plugin Bar
        this.pluginBar.visible = (connected && paired && plugins.length);

        let buttons = {
            findmyphone: this.findmyphoneButton,
            mousepad: this.mousepadButton,
            runcommand: this.runcommandButton,
            sftp: this.sftpButton,
            share: this.shareButton,
            telephony: this.telephonyButton
        };

        for (let name in buttons) {
            buttons[name].visible = (this.device.hasOwnProperty(name));
        }

        if (this.device.hasOwnProperty("runcommand")) {
            // FIXME: don't use JSON
            try {
                let commands = JSON.parse(this.device.runcommand.commands);

                // FIXME :can't convert null to objec
                if (commands) {
                    this.runcommandButton.visible = (Object.keys(commands).length);
                }
            } catch (e) {
                debug("Error loading commands: " + e);
            }
        }

        // Status Bar
        this.statusBar.visible = (!connected || !paired || !plugins.length);

        if (!connected) {
            this.statusLabel.text = _("Device is disconnected");
        } else if (!paired) {
            this.statusLabel.text = _("Device is unpaired");
        } else if (!plugins.length) {
            this.statusLabel.text = _("No plugins enabled");
        }
    },

    // Plugin Callbacks
    _findmyphoneAction: function (button) {
        debug("extension.DeviceMenu._findmyphoneAction()");
        this._getTopMenu().close(true);

        if (this.device.actions.get_action_enabled("find")) {
            this.device.actions.activate_action("find", null);
        }
    },

    _mousepadAction: function (button) {
        debug("extension.DeviceMenu._mousepadAction()");
        this._getTopMenu().close(true);
    },

    _runcommandAction: function (button) {
        debug("extension.DeviceMenu._runcommandAction()");

        if (button.checked) {
            this.sftpButton.checked = false;
            this.listPanel.actor.destroy_all_children();
        } else {
            this.listPanel.actor.visible = false;
            return;
        }

        this._runcommandList();
    },

    _runcommandList: function () {
        debug("extension.DeviceMenu._runcommandList()");

        let commands = JSON.parse(this.device.runcommand.commands);

        for (let key in commands) {
            let commandItem = new PopupMenu.PopupMenuItem(commands[key].name);
            let icon = new St.Icon({
                icon_name: GLib.path_get_basename(commands[key].command),
                fallback_icon_name: "system-run-symbolic",
                style_class: "popup-menu-icon"
            });
            commandItem.actor.insert_child_at_index(icon, 1);
            commandItem.tooltip = new Actors.Tooltip({
                parent: commandItem,
                markup: commands[key].command
            });
            commandItem.key = key;

            commandItem.connect("activate", (item) => {
                item._getTopMenu().close(true);
                this.device.runcommand.run(item.key);
            });

            this.listPanel.addMenuItem(commandItem);
        }

        this.listPanel.actor.visible = true;
    },

    _sftpAction: function (button) {
        debug("extension.DeviceMenu._sftpAction()");

        if (button.checked) {
            this.runcommandButton.checked = false;
            this.listPanel.actor.destroy_all_children();
        } else {
            this.listPanel.actor.visible = false;
            return;
        }

        if (this.device.sftp.mounted) {
            this._sftpList();
        } else {
            this._sftpNotify = this.device.sftp.connect("notify::mounted", () => {
                if (this.device.sftp.mounted) {
                    this._sftpList();
                } else {
                    Main.notifyError(
                        this.device.name,
                        // TRANSLATORS: eg. Failed to mount Google Pixel
                        _("Failed to mount %s").format(this.device.name)
                    );

                    button.checked = false;
                    button.remove_style_pseudo_class("active");
                }

                this.device.sftp.disconnect(this._sftpNotify);
            });

            this.device.sftp.mount();
        }
    },

    _sftpList: function () {
        debug("extension.DeviceMenu._sftpList()");

        for (let name in this.device.sftp.directories) {
            let mountItem = new PopupMenu.PopupMenuItem(name);
            mountItem.path = this.device.sftp.directories[name];

            mountItem.connect("activate", (item) => {
                item._getTopMenu().close(true);
                Gio.AppInfo.launch_default_for_uri(
                    "file://" + item.path,
                    null
                );
            });

            this.listPanel.addMenuItem(mountItem);
        }

        let unmountItem = new PopupMenu.PopupMenuItem(_("Unmount"));
        unmountItem._ornamentLabel.text = "\u23CF";
        unmountItem.connect("activate", (item) => {
            item._getTopMenu().close(true);
            let sftp = this.device._plugins.get("sftp");
        });
        this.listPanel.addMenuItem(unmountItem);

        this.listPanel.actor.visible = true;
    },

    _shareAction: function (button) {
        debug("extension.DeviceMenu._shareAction()");
        this._getTopMenu().close(true);

        if (this.device.actions.get_action_enabled("shareDialog")) {
            this.device.actions.activate_action("shareDialog", null);
        }
    },

    _telephonyAction: function (button) {
        debug("extension.DeviceMenu._telephonyAction()");
        this._getTopMenu().close(true);

        if (this.device.actions.get_action_enabled("openSms")) {
            this.device.actions.activate_action("openSms", null);
        }
    },

    destroy: function () {
        gsconnect.settings.disconnect(this._settingsChanged);
        PopupMenu.PopupMenuSection.prototype.destroy.call(this);
    }
});


/** An indicator representing a Device in the Status Area */
var DeviceIndicator = new Lang.Class({
    Name: "GSConnectShellDeviceIndicator",
    Extends: PanelMenu.Button,

    _init: function (daemon, device) {
        this.parent(null, device.name + " Indicator", false);

        this.daemon = daemon;
        this.device = device;

        // Device Icon
        this.icon = new St.Icon({
            icon_name: "smartphone-disconnected",
            style_class: "system-status-icon"
        });
        this.actor.add_actor(this.icon);

        this.deviceMenu = new DeviceMenu(daemon, device);
        this.menu.addMenuItem(this.deviceMenu);

        // Signals
        this._settingsChanged = gsconnect.settings.connect("changed", () => this._sync());
        device.connect("notify::connected", Lang.bind(this, this._sync));
        device.connect("notify::paired", Lang.bind(this, this._sync));

        this._sync(device);
    },

    _sync: function (sender, cb_data) {
        debug("extension.DeviceIndicator._sync()");

        let { connected, paired, type } = this.device;

        // Device Indicator Visibility
        if (!gsconnect.settings.get_boolean("show-indicators")) {
            this.actor.visible = false;
        } else if (!paired && !gsconnect.settings.get_boolean("show-unpaired")) {
            this.actor.visible = false;
        } else if (!connected && !gsconnect.settings.get_boolean("show-offline")) {
            this.actor.visible = false;
        } else {
            this.actor.visible = true;
        }

        // Indicator Icon
        let icon = (type === "phone") ? "smartphone" : type;
        icon = (type === "unknown") ? "laptop" : icon;

        if (paired && connected) {
            this.icon.icon_name = icon + "connected";
        } else if (paired) {
            this.icon.icon_name = icon + "trusted";
        } else {
            this.icon.icon_name = icon + "disconnected";
        }
    },

    destroy: function () {
        gsconnect.settings.disconnect(this._settingsChanged);
        this.deviceMenu.destroy();
        delete this.deviceMenu;
        PanelMenu.Button.prototype.destroy.call(this);
    }
});

/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
var SystemIndicator = new Lang.Class({
    Name: "GSConnectShellSystemIndicator",
    Extends: PanelMenu.SystemIndicator,

    _init: function () {
        this.parent();

        this.daemon = new Client.Daemon();
        this._indicators = {};
        this._menus = {};

        // Extension Indicator
        this.extensionIndicator = this._addIndicator();
        this.extensionIndicator.icon_name = "org.gnome.Shell.Extensions.GSConnect-symbolic";
        let userMenuTray = Main.panel.statusArea.aggregateMenu._indicators;
        userMenuTray.insert_child_at_index(this.indicators, 0);

        // Extension Menu
        this.extensionMenu = new PopupMenu.PopupSubMenuMenuItem(
            _("Mobile Devices"),
            true
        );
        this.extensionMenu.icon.icon_name = this.extensionIndicator.icon_name;
        this.menu.addMenuItem(this.extensionMenu);

        // Devices Section
        this.devicesSection = new PopupMenu.PopupMenuSection();
        gsconnect.settings.bind(
            "show-indicators",
            this.devicesSection.actor,
            "visible",
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.extensionMenu.menu.addMenuItem(this.devicesSection);

        // FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME FIXME
        // Do Not Disturb Item
        this.dndItem = new DoNotDisturbItem();
        this.extensionMenu.menu.addMenuItem(this.dndItem);

        this.extensionMenu.menu.addAction(_("Mobile Settings"), () => {
            GLib.spawn_command_line_async(
                "gnome-shell-extension-prefs gsconnect@andyholmes.github.io"
            );
        });

        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);

        // Menu Visibility
        this._settingsChanged = gsconnect.settings.connect("changed", () => {
            for (let dbusPath in this._menus) {
                this._displayMode(this._menus[dbusPath]);
            }
        });

        // Watch for DBus service
        this._serviceName = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            "org.gnome.Shell.Extensions.GSConnect",
            Gio.BusNameWatcherFlags.NONE,
            () => this._serviceAppeared(),
            () => this._serviceVanished()
        );
    },

    _serviceAppeared: function () {
        debug("creating a service proxy");

        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }

        this.extensionIndicator.visible = true;

        // Add currently managed devices
        for (let dbusPath of this.daemon.devices) {
            this._onDeviceAdded(this.daemon, dbusPath);
        }

        // Watch for new and removed devices
        this.daemon.connect("notify::devices", () => this._onDevicesChanged());
    },

    _serviceVanished: function () {
        debug("destroying the service proxy");

        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }

        this.extensionIndicator.visible = false;

        this._serviceAppeared();
    },

    /**
     * This is connected to the Shell notification's destroy signal by
     * overriding MessageTray.Source.pushNotification().
     *
     * TODO:
     * If the session state has changed the daemon should have already stopped
     * and the remote notification shouldn't be closed.
     */
    _onNotificationDestroyed: function (id) {
        debug(id);

        if (!this.daemon) {
            debug("daemon not connected");
            return;
        }

        // Separate the device id from the notification id
        id = id.split("|");
        let deviceId = id.splice(0, 1)[0];
        id = id.join("|");

        // Search for a matching device with the notification plugin enabled
        for (let device of this.daemon._devices.values()) {
            if (deviceId === device.id && device.notification) {
                device.notification.closeNotification(id);
                break;
            }
        }
    },

    _sftpDevice: function (indicator) {
        let menu;

        if (gsconnect.settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
            menu = indicator.deviceMenu;
        } else {
            this._openDeviceMenu();
            for (let dbusPath in this._menus) {
                if (this._menus[dbusPath].device.id === indicator.device.id) {
                    menu = this._menus[dbusPath];
                }
            }
        }

        menu.sftpButton.checked = !menu.sftpButton.checked;
        menu.sftpButton.emit("clicked", menu.sftpButton);
    },

    _openDeviceMenu: function (indicator) {
        if (gsconnect.settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
        } else {
            Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
            this.extensionMenu.menu.toggle();
            this.extensionMenu.actor.grab_key_focus();
        }
    },

    _displayMode: function (menu) {
        let { connected, paired } = menu.device;

        if (!paired && !gsconnect.settings.get_boolean("show-unpaired")) {
            menu.actor.visible = false;
        } else if (!connected && !gsconnect.settings.get_boolean("show-offline")) {
            menu.actor.visible = false;
        } else {
            menu.actor.visible = true;
        }
    },

    _onDevicesChanged: function (daemon, dbusPath) {
        for (let dbusPath of this.daemon.devices) {
            if (!this._indicators[dbusPath]) {
                this._onDeviceAdded(this.daemon, dbusPath);
            }
        }
    },

    _onDeviceAdded: function (daemon, dbusPath) {
        debug(arguments);

        let device = this.daemon._devices.get(dbusPath);

        // Device Indicator
        let indicator = new DeviceIndicator(daemon, device);
        this._indicators[dbusPath] = indicator;
        Main.panel.addToStatusArea(dbusPath, indicator);

        // Device Menu
        let menu = new DeviceMenu(daemon, device);
        this._menus[dbusPath] = menu;

        this.devicesSection.addMenuItem(menu);
        this._displayMode(menu);

        // Destroy with device TODO
        device.connect("notify::connected", () => this._displayMode(menu));
        device.connect("notify::paired", () => this._displayMode(menu));
        device.connect("destroy", (device) => {
            menu.destroy();
            delete this._menus[device.g_object_path];
            indicator.destroy();
            delete this._indicators[device.g_object_path];
        });

        // Try activating the device
        device.activate();
    },

    destroy: function () {
        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }

        gsconnect.settings.disconnect(this._settingsChanged);

        // Destroy the UI
        this.extensionMenu.destroy();
        this.indicators.destroy();
        this.menu.destroy();

        // Stop watching for DBus Service
        Gio.bus_unwatch_name(this._serviceName);
    }
});


/**
 * Monkey-patch for Gnome Shell notifications
 *
 * This removes the notification limit for GSConnect and connects close events
 * to the notification plugin so Shell notifications work as expected.
 */
var pushNotification = function (notification) {
    if (this.notifications.indexOf(notification) >= 0)
        return;

    if (this._appId && this._appId === "org.gnome.Shell.Extensions.GSConnect") {
        // Look for the GNotification id
        for (let id in this._notifications) {
            if (this._notifications[id] === notification) {
                debug("connecting to shell notification: " + id);

                // Close the notification remotely when dismissed
                notification.connect("destroy", (notification, reason) => {
                    if (reason === MessageTray.NotificationDestroyedReason.DISMISSED) {
                        systemIndicator._onNotificationDestroyed(id);
                    }
                });
                break;
            }
        }
    } else {
        while (this.notifications.length >= MessageTray.MAX_NOTIFICATIONS_PER_SOURCE) {
            this.notifications.shift().destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        }
    }

    notification.connect('destroy', Lang.bind(this, this._onNotificationDestroy));
    notification.connect('acknowledged-changed', Lang.bind(this, this.countUpdated));
    this.notifications.push(notification);
    this.emit('notification-added', notification);

    this.countUpdated();
};

var systemIndicator;

function init() {
    debug("initializing extension");

    MessageTray.Source.prototype.pushNotification = pushNotification;
}

function enable() {
    debug("enabling extension");

    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);
    systemIndicator = new SystemIndicator();
}

function disable() {
    debug("disabling extension");

    systemIndicator.destroy();
}

