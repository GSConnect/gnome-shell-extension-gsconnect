"use strict";

// Imports
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Client = Me.imports.client;
const Common = Me.imports.common;
const { Resources, Settings } = Me.imports.common;
const ShellWidget = Me.imports.widgets.shell;


/**
 * Keyboard shortcuts
 *
 * References:
 *     https://developer.gnome.org/meta/stable/MetaDisplay.html
 *     https://developer.gnome.org/meta/stable/meta-MetaKeybinding.html
 *
 */
var KeybindingManager = new Lang.Class({
    Name: "GSConnectShellKeybindingManager",

    _init: function (devices) {
        this.bindings = new Map();
        
        this._handler = global.display.connect(
            'accelerator-activated',
            Lang.bind(this, (display, action, deviceId, timestamp) => {
                if (this.bindings.has(action)) {
                    this.bindings.get(action).callback()
                }
            })
        );
    },

    add: function(accelerator, callback){
        Common.debug("KeybindingManager.add(" + accelerator + ")");
        
        let action = global.display.grab_accelerator(accelerator);

        if (action !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(action);

            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL)

            this.bindings.set(action, {
                name: name,
                accelerator: accelerator,
                callback: callback
            });
        } else {
            log("failed to grab accelerator: "+ accelerator);
        }
        
        return action;
    },

    remove: function (action) {
        if (action !== 0) {
            let binding = this.bindings.get(action);
            
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(binding.name, Shell.ActionMode.NONE);
            this.bindings.delete(action);
        }
    },
    
    removeAll: function () {
        for (let action of this.bindings.keys()) {
            this.remove(action);
        }
    },
    
    destroy: function () {
        this.removeAll();
        GObject.signal_handler_disconnect(global.display, this._handler);
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
        
        this.deviceButton = new ShellWidget.DeviceButton(this.device);
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
        device.connect("notify::name", Lang.bind(this, this._sync));
        device.connect("notify::plugins", Lang.bind(this, this._sync));
        device.connect("notify::connected", Lang.bind(this, this._sync));
        device.connect("notify::paired", Lang.bind(this, this._sync));
        
        this.actor.connect("notify::visible", Lang.bind(this, this._sync));
        this._settingsChanged = Settings.connect("changed", Lang.bind(this, this._sync));
        
        this._sync(device);
    },
    
    _sync: function (device) {
        Common.debug("extension.DeviceMenu._sync()");
        
        if (!this.actor.visible) { return; }
        
        let { connected, paired, plugins } = this.device;
        
        // Title Bar
        // Fix for "st_label_set_text: assertion 'text != NULL' failed"
        this.nameLabel.text = this.device.name || "";
        
        if (connected && paired && Settings.get_boolean("show-battery")) {
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
            let commands = JSON.parse(this.device.runcommand.commands);
            this.runcommandButton.visible = (Object.keys(commands).length);
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
        Common.debug("extension.DeviceMenu._findmyphoneAction()");
        this._getTopMenu().close(true);
        this.device.find();
    },
    
    _mousepadAction: function (button) {
        Common.debug("extension.DeviceMenu._mousepadAction()");
        this._getTopMenu().close(true);
    },
    
    _runcommandAction: function (button) {
        Common.debug("extension.DeviceMenu._runcommandAction()");
        
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
        Common.debug("extension.DeviceMenu._runcommandList()");
        
        let commands = JSON.parse(this.device.runcommand.commands);
        
        for (let key in commands) {
            let commandItem = new PopupMenu.PopupMenuItem(commands[key].name);
            let icon = new St.Icon({
                icon_name: GLib.path_get_basename(commands[key].command),
                fallback_icon_name: "system-run-symbolic",
                style_class: "popup-menu-icon"
            });
            commandItem.actor.insert_child_at_index(icon, 1);
            commandItem.tooltip = new ShellWidget.Tooltip({
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
        Common.debug("extension.DeviceMenu._sftpAction()");
        
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
        Common.debug("extension.DeviceMenu._sftpList()");
        
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
        
        this.listPanel.actor.visible = true;
    },
    
    _shareAction: function (button) {
        Common.debug("extension.DeviceMenu._shareAction()");
        this._getTopMenu().close(true);
        this.device.shareDialog();
    },
    
    _telephonyAction: function (button) {
        Common.debug("extension.DeviceMenu._telephonyAction()");
        this._getTopMenu().close(true);
        this.device.telephony.openSms();
    },
    
    destroy: function () {
        Settings.disconnect(this._settingsChanged);
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
        this._settingsChanged = Settings.connect("changed", Lang.bind(this, this._sync));
        device.connect("notify::connected", Lang.bind(this, this._sync));
        device.connect("notify::paired", Lang.bind(this, this._sync));
        
        this._sync(device);
    },
    
    _sync: function (sender, cb_data) {
        Common.debug("extension.DeviceIndicator._sync()");
        
        let { connected, paired, type } = this.device;
        
        // Device Indicator Visibility
        if (!Settings.get_boolean("show-indicators")) {
            this.actor.visible = false;
        } else if (!paired && !Settings.get_boolean("show-unpaired")) {
            this.actor.visible = false;
        } else if (!connected && !Settings.get_boolean("show-offline")) {
            this.actor.visible = false;
        } else {
            this.actor.visible = true;
        }
        
        // Indicator Icon
        // TODO: desktop-* icons not rendering, fallback being used
        let icon = (type === "phone") ? "smartphone" : type;
        icon = (type === "unknown") ? "laptop" : icon;
        
        if (paired && connected) {
            this.icon.icon_name = icon + "-connected";
        } else if (paired) {
            this.icon.icon_name = icon + "-trusted";
        } else {
            this.icon.icon_name = icon + "-disconnected";
        }
    },
    
    destroy: function () {
        Settings.disconnect(this._settingsChanged);
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
        this.keybindingManager = new KeybindingManager();
        
        this._integrateNautilus();
        Settings.connect(
            "changed::nautilus-integration",
            Lang.bind(this, this._integrateNautilus)
        );
        
        this.extensionIndicator = this._addIndicator();
        this.extensionIndicator.icon_name = "gsconnect-symbolic";
        let userMenuTray = Main.panel.statusArea.aggregateMenu._indicators;
        userMenuTray.insert_child_at_index(this.indicators, 0);
        
        this.extensionMenu = new PopupMenu.PopupSubMenuMenuItem(
            _("Mobile Devices"),
            true
        );
        this.extensionMenu.icon.icon_name = this.extensionIndicator.icon_name;
        this.menu.addMenuItem(this.extensionMenu);
        
        this.devicesSection = new PopupMenu.PopupMenuSection();
        Settings.bind(
            "show-indicators",
            this.devicesSection.actor,
            "visible",
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.extensionMenu.menu.addMenuItem(this.devicesSection);
        
        this.extensionMenu.menu.addAction(
            _("Mobile Settings"), 
            Common.startPreferences
        );
        
        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);
        
        // Watch for DBus service
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            Client.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );
    },
    
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        Common.debug("extension.SystemIndicator._serviceAppeared()");
        
        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }
        
        this.extensionIndicator.visible = (this.daemon);
        
        // Add currently managed devices
        for (let dbusPath of this.daemon.devices.keys()) {
            this._deviceAdded(this.daemon, dbusPath);
        }
        
        // Watch for new and removed devices
        this.daemon.connect(
            "device::added",
            Lang.bind(this, this._deviceAdded)
        );
        
        this.daemon.connect(
            "device::removed",
            Lang.bind(this, this._deviceRemoved)
        );
    },
    
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        Common.debug("extension.SystemIndicator._serviceVanished()");
        
        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }
        
        this.extensionIndicator.visible = (this.daemon);
        
        if (!Settings.get_boolean("debug")) {
            this.daemon = new Client.Daemon();
        }
    },
    
    _deviceKeybindings: function (indicator) {
        let menu = indicator.deviceMenu;
        
        for (let binding of menu._keybindings) {
            this.keybindingManager.remove(binding);
        }
        menu._keybindings = [];
        
        let accels = JSON.parse(menu.device.settings.get_string("keybindings"));
        
        if (accels.menu) {
            menu._keybindings.push(
                this.keybindingManager.add(
                    accels.menu,
                    Lang.bind(this, this._openDeviceMenu, indicator)
                )
            );
        }
        
        if (accels.sms) {
            menu._keybindings.push(
                this.keybindingManager.add(
                    accels.sms, 
                    Lang.bind(menu, menu._telephonyAction)
                )
            );
        }
        
        if (accels.find) {
            menu._keybindings.push(
                this.keybindingManager.add(
                    accels.find, 
                    Lang.bind(menu, menu._findmyphoneAction)
                )
            );
        }
        
        if (accels.browse) {
            menu._keybindings.push(
                this.keybindingManager.add(
                    accels.browse,
                    Lang.bind(this, this._sftpDevice, indicator)
                )
            );
        }
        
        if (accels.share) {
            menu._keybindings.push(
                this.keybindingManager.add(
                    accels.share,
                    Lang.bind(menu, menu._shareAction)
                )
            );
        }
    },
    
    _browseDevice: function (indicator) {
        let menu;
        
        if (Settings.get_boolean("show-indicators")) {
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
        if (Settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
        } else {
            Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
            this.extensionMenu.menu.toggle();
            this.extensionMenu.actor.grab_key_focus();
        }
    },
    
    _deviceAdded: function (daemon, dbusPath) {
        Common.debug("extension.SystemIndicator._deviceAdded(" + dbusPath + ")");
        
        let device = this.daemon.devices.get(dbusPath);
        
        // Status Area -> [ Device Indicator ]
        let indicator = new DeviceIndicator(daemon, device);
        this._indicators[dbusPath] = indicator;
        Main.panel.addToStatusArea(dbusPath, indicator);
        
        // Extension Menu -> [ Devices Section ] -> Device Menu
        let menu = new DeviceMenu(daemon, device);
        this._menus[dbusPath] = menu;
        
        device.connect("notify::connected", () => {
            this._deviceMenuVisibility(menu);
        });
        device.connect("notify::paired", () => {
            this._deviceMenuVisibility(menu);
        });
        
        this.devicesSection.addMenuItem(menu);
        this._deviceMenuVisibility(menu);
        
        // Keybindings
        device.settings.connect("changed::keybindings", () => {
            this._deviceKeybindings(indicator);
        });
        this._deviceKeybindings(indicator);
        
        // Try activating the device
        device.activate();
    },
    
    _deviceRemoved: function (daemon, dbusPath) {
        Common.debug("extension.SystemIndicator._deviceRemoved(" + dbusPath + ")");
        
        for (let binding of this._indicators[dbusPath].deviceMenu._keybindings) {
            this.keybindingManager.remove(binding);
        }
        this._indicators[dbusPath].deviceMenu._keybindings = [];
        
        Main.panel.statusArea[dbusPath].destroy();
        delete this._indicators[dbusPath];
        
        this._menus[dbusPath].destroy();
        delete this._menus[dbusPath];
    },
    
    _deviceMenuVisibility: function (menu){
        let { connected, paired } = menu.device;
        
        if (!paired && !Settings.get_boolean("show-unpaired")) {
            menu.actor.visible = false;
        } else if (!connected && !Settings.get_boolean("show-offline")) {
            menu.actor.visible = false;
        } else {
            menu.actor.visible = true;
        }
    },
    
    _notifyNautilus: function () {
        let source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);
    
        let notification = new MessageTray.Notification(
            source,
            _("Nautilus extensions changed"),
            _("Restart Nautilus to apply changes"),
            { gicon: new Gio.ThemedIcon({ name: "system-file-manager-symbolic" }) }
        );
        
        notification.setTransient(true);
        notification.addAction(_("Restart"), () => {
            GLib.spawn_command_line_async("nautilus -q");
        });
        
        source.notify(notification);
    },
    
    _integrateNautilus: function () {
        let path = GLib.get_user_data_dir() + "/nautilus-python/extensions";
        let dir = Gio.File.new_for_path(path);
        let script = dir.get_child("nautilus-gsconnect.py");
        let scriptExists = script.query_exists(null);
        let integrate = Settings.get_boolean("nautilus-integration");
        
        if (integrate && !scriptExists) {
            if (!dir.query_exists(null)) {
                GLib.mkdir_with_parents(path, 493); // 0755 in octal
            }
            
            script.make_symbolic_link(
                Me.path + "/nautilus-gsconnect.py",
                null
            );
            this._notifyNautilus();
        } else if (!integrate && scriptExists) {
            script.delete(null);
            this._notifyNautilus();
        }
    },
    
    destroy: function () {
        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }
        
        for (let dbusPath in this._indicators) {
            this._deviceRemoved(this.daemon, dbusPath);
        }
        
        this.keybindingManager.destroy();
        
        // Destroy the UI
        this.extensionMenu.destroy();
        this.indicators.destroy();
        this.menu.destroy();
        
        // Stop watching for DBus Service
        Gio.bus_unwatch_name(this._watchdog);
    }
});

var systemIndicator;

function init() {
    Common.debug("initializing extension");
}

function enable() {
    Common.debug("enabling extension");
    
    Common.initConfiguration();
    systemIndicator = new SystemIndicator();
}

function disable() {
    Common.debug("disabling extension");
    
    GObject.signal_handlers_destroy(Settings);
    systemIndicator.destroy();
    Common.uninstallService()
}

