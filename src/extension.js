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
    Name: "GSConnectKeybindingManager",

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
    Name: "GSConnectDeviceMenu",
    Extends: PopupMenu.PopupMenuSection,

    _init: function (daemon, device) {
        this.parent();

        this.device = device;
        this.daemon = daemon;
        this._keybindings = [];
        
        // Info Bar
        this.infoBar = new PopupMenu.PopupSeparatorMenuItem(device.name);
        this.infoBar.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.addMenuItem(this.infoBar);
        
        this.batteryLabel = new St.Label();
        this.batteryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.infoBar.actor.add(this.batteryLabel);
        
        this.batteryIcon = new St.Icon({
            icon_name: "battery-missing-symbolic",
            style_class: "popup-menu-icon"
        });
        this.infoBar.actor.add(this.batteryIcon);
        
        // Plugin Bar
        this.pluginBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        }); 
        this.addMenuItem(this.pluginBar);
        
        this.smsButton = new ShellWidget.Button({
            icon_name: "sms-symbolic",
            callback: Lang.bind(this, this._smsAction),
            tooltip_text: _("Send SMS")
        });
        this.pluginBar.actor.add(this.smsButton, { expand: true, x_fill: false });
        
        this.findButton = new ShellWidget.Button({
            icon_name: "find-location-symbolic",
            callback: Lang.bind(this, this._findAction),
            tooltip_text: _("Locate %s").format(this.device.name)
        });
        this.pluginBar.actor.add(this.findButton, { expand: true, x_fill: false });
        
        this.browseButton = new ShellWidget.Button({
            icon_name: "folder-remote-symbolic",
            callback: Lang.bind(this, this._browseAction),
            toggle_mode: true,
            tooltip_text: _("Browse Files")
        });
        this.pluginBar.actor.add(this.browseButton, { expand: true, x_fill: false });
        
        this.shareButton = new ShellWidget.Button({
            icon_name: "send-to-symbolic",
            callback: Lang.bind(this, this._shareAction),
            tooltip_text: _("Share File/URL")
        });
        this.pluginBar.actor.add(this.shareButton, { expand: true, x_fill: false });
        
        // Browse Bar
        this.browseBar = new PopupMenu.PopupMenuSection({
            reactive: false,
            can_focus: false
        });
        this.browseBar.actor.style_class = "popup-sub-menu";
        this.browseBar.actor.visible = false;
        this.addMenuItem(this.browseBar);
        
        // Status Bar
        this.statusBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.addMenuItem(this.statusBar);
        
        this.statusButton = new ShellWidget.Button({
            icon_name: "channel-insecure-symbolic",
            callback: Lang.bind(this, this._statusAction),
            tooltip_text: "" // placeholder, strings in this._statusChanged()
        });
        this.statusBar.actor.add(this.statusButton, { x_fill: false });
        
        this.statusLabel = new St.Label({
            text: "", // placeholder, strings in this._statusChanged()
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.actor.add(this.statusLabel, { x_expand: true });
        
        // Help Bar
        this.helpBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.helpBar.actor.visible = false;
        this.addMenuItem(this.helpBar);
        
        this.helpButton = new ShellWidget.Button({ tooltip_text: "" });
        this.helpBar.actor.add(this.helpButton, { x_fill: false });
        
        this.helpLabel = new St.Label({
            text: "", // placeholder, set by enabling function
            y_align: Clutter.ActorAlign.CENTER
        });
        this.helpBar.actor.add(this.helpLabel, { x_expand: true });
        
        // Property signals
        device.connect(
            "notify::name",
            Lang.bind(this, this._nameChanged)
        );
        device.connect(
            "notify::plugins",
            Lang.bind(this, this._pluginsChanged)
        );
        device.connect(
            "notify::connected",
            Lang.bind(this, this._statusChanged)
        );
        device.connect(
            "notify::paired",
            Lang.bind(this, this._statusChanged)
        );
        
        this._statusChanged(device);
    },
    
    // Callbacks
    _batteryChanged: function (battery) {
        Common.debug("extension.DeviceMenu._batteryChanged()");
        
        // Fix for "JS ERROR: TypeError: this.device.battery is undefined"
        if (this.device.battery === undefined) { return; }
        
        let {charging, level} = this.device.battery;
        let icon = "battery";
        
        if (level < 3) {
            icon += "-empty";
        } else if (level < 10) {
            icon += "-caution";
        } else if (level < 30) {
            icon += "-low";
        } else if (level < 60) {
            icon += "-good";
        } else if (level >= 60) {
            icon += "-full";
        }
        
        icon = (charging) ? icon + "-charging" : icon;
        this.batteryIcon.icon_name = icon + "-symbolic";
        this.batteryLabel.text = level + "%";
        
        // KDE Connect: "false, -1" if remote plugin is disabled but not local
        if (level === -1) {
            this.batteryIcon.icon_name = "battery-missing-symbolic";
            this.batteryLabel.text = "";
        }
    },
    
    _nameChanged: function (device, name) {
        Common.debug("extension.DeviceMenu._nameChanged()");
        
        this.nameLabel.label.text = this.device.name;
    },
    
    _pluginsChanged: function (device) {
        Common.debug("extension.DeviceMenu._pluginsChanged()");
        
        let { connected, paired, plugins } = this.device;
        
        if (!plugins.length && connected && paired) {
            this.helpBar.actor.visible = true;
            this.helpButton.child.icon_name = "preferences-other-symbolic";
            this.helpButton.tooltip.title = _("Mobile Settings");
            this.helpButton.callback = Common.startPreferences;
            this.helpLabel.text = _("No plugins enabled");
        } else {
            this.helpBar.actor.visible = false;
        }
        
        // Plugin Buttons
        let buttons = {
            findmyphone: this.findButton,
            sftp: this.browseButton,
            share: this.shareButton,
            telephony: this.smsButton
        };
        let sensitive;
        
        for (let name in buttons) {
            sensitive = (this.device.hasOwnProperty(name));
            buttons[name].can_focus = sensitive;
            buttons[name].reactive = sensitive;
            buttons[name].track_hover = sensitive;
            buttons[name].opacity = sensitive ? 255 : 128;
        }
        
        // Battery Plugin
        if (this.device.hasOwnProperty("battery")) {
            this.device.battery.connect(
                "notify",
                Lang.bind(this, this._batteryChanged)
            );
            this.device.battery.notify("level");
        } else {
            this.batteryIcon.icon_name = "battery-missing-symbolic";
            this.batteryLabel.text = "";
        }
    },
    
    _statusChanged: function (device, state) {
        Common.debug("extension.DeviceMenu._statusChanged(" + this.device.name + ")");
        
        let { connected, paired } = this.device;
        
        this.pluginBar.actor.visible = (connected && paired);
        this.statusBar.actor.visible = (!connected || !paired);
        this.batteryIcon.visible = (connected && paired);
        
        if (!connected) {
            this.statusButton.child.icon_name = "view-refresh-symbolic";
            this.statusButton.tooltip.title = _("Reconnect <b>%s</b>").format(this.device.name);
            this.statusLabel.text = _("Device is disconnected");
        } else if (!paired) {
            this.statusButton.child.icon_name = "channel-insecure-symbolic";
            this.statusButton.tooltip.title = _("Pair <b>%s</b>\n\n").format(this.device.name) + _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.name, this.device.fingerprint, this.daemon.fingerprint);
            this.statusLabel.text = _("Device is unpaired");
        }
        
        this._pluginsChanged(this.device);
    },
    
    // Plugin Callbacks
    _browseAction: function (button) {
        Common.debug("extension.DeviceMenu._browseAction()");
        
        if (button.checked) {
            button.add_style_pseudo_class("active");
        } else {
            button.remove_style_pseudo_class("active");
            this.browseBar.actor.visible = false;
            return;
        }
        
        if (this.device.sftp.mounted) {
            this._browseOpen();
        } else {
            this._browseNotify = this.device.sftp.connect("notify::mounted", () => {
                if (this.device.sftp.mounted) {
                    this._browseOpen();
                } else {
                    Main.notifyError(
                        this.device.name,
                        // TRANSLATORS: eg. Failed to mount Google Pixel
                        _("Failed to mount %s").format(this.device.name)
                    );
                    
                    button.checked = false;
                    button.remove_style_pseudo_class("active");
                }
                
                GObject.signal_handler_disconnect(
                    this.device.sftp,
                    this._browseNotify
                );
            });
        
            this.device.sftp.mount();
        }
    },
    
    _browseOpen: function () {
        Common.debug("extension.DeviceMenu._browseOpen()");
        
        this.browseBar.actor.destroy_all_children();
        
        for (let name in this.device.sftp.directories) {
            let mountItem = new PopupMenu.PopupMenuItem(name);
            mountItem.path = this.device.sftp.directories[name];
            
            mountItem.connect("activate", (item) => {
                this.browseButton.checked = false;
                this.browseButton.remove_style_pseudo_class("active");
                this.browseBar.actor.visible = false;
                item._getTopMenu().close(true);
                Gio.AppInfo.launch_default_for_uri(
                    "file://" + item.path,
                    null
                );
            });
            
            this.browseBar.addMenuItem(mountItem);
        }
        
        this.browseBar.actor.visible = true;
    },
    
    _findAction: function (button) {
        Common.debug("extension.DeviceMenu._findAction()");
        this._getTopMenu().close(true);
        this.device.ring();
    },
    
    _shareAction: function (button) {
        Common.debug("extension.DeviceMenu._shareAction()");
        this._getTopMenu().close(true);
        this.device.shareDialog();
    },
    
    _smsAction: function (button) {
        Common.debug("extension.DeviceMenu._smsAction()");
        this._getTopMenu().close(true);
        this.device.telephony.openSms();
    },
    
    _statusAction: function (button) {
        Common.debug("extension.DeviceMenu._statusAction()");
        
        if (this.device.connected && !this.device.paired) {
            this.device.pair();
        } else {
            this.device.activate();
        }
    }
});


/** An indicator representing a Device in the Status Area */
var DeviceIndicator = new Lang.Class({
    Name: "GSConnectDeviceIndicator",
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
        Settings.connect("changed::show-indicators", Lang.bind(this, this._sync));
        Settings.connect("changed::show-offline", Lang.bind(this, this._sync));
        Settings.connect("changed::show-unpaired", Lang.bind(this, this._sync));
        
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
        let icon = (type === "phone") ? "smartphone" : type;
        icon = (type === "desktop") ? "laptop" : icon;
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
    Name: "GSConnectSystemIndicator",
    Extends: PanelMenu.SystemIndicator,
    
    _init: function () {
        this.parent();
        
        this.daemon = new Client.Daemon();
        this._indicators = {};
        this._menus = {};
        this.keybindingManager = new KeybindingManager();
        this._keybindings = [];
        
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
        
        // Keybindings
        this._extensionKeybindings();
        
        Settings.connect("changed::device-keybindings", () => {
            for (let dbusPath in this._indicators) {
                this._deviceKeybindings(this._indicators[dbusPath]);
            }
        });
        
        Settings.connect("changed::extension-keybindings", () => {
            this._extensionKeybindings();
        });
        
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
        
        this.scanItem = this.extensionMenu.menu.addAction("", () => {
            this._discoverDevices();
        });
        this.daemon.connect("notify::discovering", () => {
            if (this.daemon.discovering) {
                this.scanItem.actor.reactive = false;
                this.scanItem.label.text = _("Discovering Devices");
            } else {
                this.scanItem.actor.reactive = true;
                this.scanItem.label.text = _("Discover Devices");
            }
        });
        this.daemon.notify("discovering");
        this.extensionMenu.menu.box.set_child_at_index(this.scanItem.actor, 1);
        
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
        
        if (this.scanItem) { this.scanItem.destroy(); }
        
        this.extensionIndicator.visible = (this.daemon);
        
        if (!Settings.get_boolean("debug")) {
            this.daemon = new Client.Daemon();
        }
    },
    
    _extensionKeybindings: function () {
        for (let binding of this._keybindings) {
            this.keybindingManager.remove(binding);
        }
        this._keybindings = [];
    
        let accels = Settings.get_string("extension-keybindings");
        accels = JSON.parse(accels);
        
        if (accels.hasOwnProperty("menu") && accels.menu.length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    accels.menu,
                    Lang.bind(this, this._openMenu)
                )
            );
        }
        
        if (accels.hasOwnProperty("discover") && accels.discover.length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    accels.discover,
                    Lang.bind(this, this._discoverDevices)
                )
            );
        }
        
        if (accels.hasOwnProperty("settings") && accels.settings.length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    accels.settings,
                    Lang.bind(this, Common.startPreferences)
                )
            );
        }
    },
    
    _deviceKeybindings: function (indicator) {
        let menu = indicator.deviceMenu;
        let profiles = JSON.parse(Settings.get_string("device-keybindings"));
        
        for (let binding of menu._keybindings) {
            this.keybindingManager.remove(binding);
        }
        menu._keybindings = [];
        
        if (profiles.hasOwnProperty(menu.device.id)) {
            let accels = profiles[menu.device.id];
        
            if (accels.hasOwnProperty("menu") && accels.menu.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.menu,
                        Lang.bind(this, this._openDeviceMenu, indicator)
                    )
                );
            }
            
            if (accels.hasOwnProperty("sms") && accels.sms.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.sms, 
                        Lang.bind(menu, menu._smsAction)
                    )
                );
            }
            
            if (accels.hasOwnProperty("find") && accels.find.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.find, 
                        Lang.bind(menu, menu._findAction)
                    )
                );
            }
            
            if (accels.hasOwnProperty("browse") && accels.browse.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.browse,
                        Lang.bind(this, this._browseDevice, indicator)
                    )
                );
            }
            
            if (accels.hasOwnProperty("share") && accels.share.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.share,
                        Lang.bind(menu, menu._shareAction)
                    )
                );
            }
            
            if (accels.hasOwnProperty("status") && accels.status.length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        accels.status,
                        Lang.bind(menu, menu._statusAction)
                    )
                );
            }
        }
    },
    
    _browseDevice: function (indicator) {
        let menu;
        
        if (Settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
            menu = indicator.deviceMenu;
        } else {
            this._openMenu();
            for (let dbusPath in this._menus) {
                if (this._menus[dbusPath].device.id === indicator.device.id) {
                    menu = this._menus[dbusPath];
                }
            }
        }
        
        menu.browseButton.checked = !menu.browseButton.checked;
        menu.browseButton.emit("clicked", menu.browseButton);
    },
    
    _discoverDevices: function () {
        if (this.daemon.discovering) {
            this.daemon.broadcast();
        } else {
            this.daemon.discovering = true;
            let times = 2;
            
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                if (times > 0) {
                    this.daemon.broadcast();
                    times -= 1;
                    return this.daemon.discovering;
                }
                
                this.daemon.discovering = false;
                return false;
            });
        }
    },
    
    _openDeviceMenu: function (indicator) {
        if (Settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
        } else {
            this._openMenu();
        }
    },
    
    _openMenu: function () {
        Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
        this.extensionMenu.menu.toggle();
        this.extensionMenu.actor.grab_key_focus();
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
    Common.uninitConfiguration()
}

