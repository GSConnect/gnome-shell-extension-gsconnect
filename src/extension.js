"use strict";

// Imports
const Gettext = imports.gettext.domain("gnome-shell-extension-mconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
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
const Tweener = imports.ui.tweener;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { log, debug, initTranslations, Resources, Settings } = Me.imports.lib;
const MConnect = Me.imports.mconnect;
const KDEConnect = Me.imports.kdeconnect;

// Externally Available Constants
var DeviceVisibility = {
    OFFLINE: 1,
    UNPAIRED: 2
};

var DeviceVisibilityNames = {
    OFFLINE: _("OFFLINE"),
    UNPAIRED: _("UNPAIRED")
};

var ServiceProvider = {
    MCONNECT: 0,
    KDECONNECT: 1
};


/**
 * Keyboard shortcuts
 *
 * References:
 *     https://developer.gnome.org/meta/stable/MetaDisplay.html
 *     https://developer.gnome.org/meta/stable/meta-MetaKeybinding.html
 *
 */
var KeybindingManager = new Lang.Class({
    Name: "KeybindingManager",

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
        debug("KeybindingManager.add(" + accelerator + ")");
        
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
        global.display.disconnect(this._handler);
    }
});


/** 
 * A Tooltip for ActionButton
 * 
 * Adapted from: https://github.com/RaphaelRochet/applications-overview-tooltip
 */
var ActionTooltip = new Lang.Class({
    Name: "ActionTooltip",
    
    _init: function (title, parent) {
        this._parent = parent;
        
        this._hoverTimeout = 0;
        this._labelTimeout = 0;
        this._showing = false;
        
        this.bin = null;
        this.label = null;
        this.title = title;
        
        this._parent.connect("notify::hover", Lang.bind(this, this.hover));
        this._parent.connect("clicked", Lang.bind(this, this.hover));
        this._parent.connect("destroy", Lang.bind(this, this.destroy));
    },
    
    show: function () {
        if (!this.bin) {
            this.label = new St.Label({
                style: "font-weight: normal;",
                text: this.title
            });
            this.label.clutter_text.line_wrap = true;
            this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
            this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            
            this.bin = new St.Bin({
                style_class: "osd-window",
                style: "min-width: 0; min-height: 0; padding: 6px; border-radius: 2px;"
            });
            this.bin.child = this.label;
            
            Main.layoutManager.uiGroup.add_actor(this.bin);
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bin, null);
        } else {
            this.label.text = this.title;
        }
        
        let [x, y] = this._parent.get_transformed_position();
        y = y + 12;
        x = x - Math.round(this.bin.get_width()/2.5);
        
        if (this._showing) {
            Tweener.addTween(this.bin, {
                x: x,
                y: y,
                time: 15/100,
                transition: "easeOutQuad",
            });
        } else {
            this.bin.set_position(x, y);
            Tweener.addTween(this.bin, {
                opacity: 255,
                time: 15/100,
                transition: "easeOutQuad",
            });
            
            this._showing = true;
        }
        
        if (this._hoverTimeout > 0) {
            Mainloop.source_remove(this._hoverTimeout);
            this._hoverTimeout = 0;
        }
    },
    
    hide: function () {
        if (this.bin) {
            Tweener.addTween(this.bin, {
                opacity: 0,
                time: 10/100,
                transition: 'easeOutQuad',
                onComplete: () => {
                    Main.layoutManager.uiGroup.remove_actor(this.bin);
                    this.bin.destroy();
                    this.bin = null;
                    this.label.destroy();
                    this.label = null;
                }
            });
        }
    },
    
    hover: function () {
        if (this._parent.get_hover()) {
            if (this._labelTimeout === 0) {
                if (this._showing) {
                    this.show();
                } else {
                    this._labelTimeout = Mainloop.timeout_add(500, () => {
                        this.show();
                        this._labelTimeout = 0;
                        return false;
                    });
                }
            }
        } else {
            this.leave();
        }
    },
    
    leave: function () {
        if (this._labelTimeout > 0){
            Mainloop.source_remove(this._labelTimeout);
            this._labelTimeout = 0;
        }
        
        if (this._showing) {
            this._hoverTimeout = Mainloop.timeout_add(500, () => {
                    this.hide();
                    this._showing = false;
                    this._hoverTimeout = 0;
                    return false;
            });
        }
    },
    
    destroy: function () {
        // TODO check this is done proper & signal handlers
        this.leave();
    }
});


/** An St.Button subclass for buttons with an image and an action */
var ActionButton = new Lang.Class({
    Name: "ActionButton",
    Extends: St.Button,
    
    _init: function (params) {
        params = Object.assign({
            icon_name: null,
            callback: () => {},
            toggle_mode: false,
            tooltip_text: false
        }, params);
    
        this.parent({
            style_class: "system-menu-action",
            style: "padding: 8px;",
            child: new St.Icon({ icon_name: params.icon_name }),
            toggle_mode: params.toggle_mode
        });
        this.connect("clicked", params.callback);
        
        if (typeof params.tooltip_text === "string") {
            this.tooltip = new ActionTooltip(params.tooltip_text, this);
        }
    }
});


/** A PopupMenu used as an information and control center for a device */
var DeviceMenu = new Lang.Class({
    Name: "DeviceMenu",
    Extends: PopupMenu.PopupMenuSection,

    _init: function (device, manager) {
        this.parent();

        this.device = device;
        this.manager = manager;
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
        
        this.smsButton = new ActionButton({
            icon_name: "sms-symbolic",
            callback: Lang.bind(this, this._smsAction),
            tooltip_text: _("Send SMS")
        });
        this.pluginBar.actor.add(this.smsButton, { expand: true, x_fill: false });
        
        this.findButton = new ActionButton({
            icon_name: "find-location-symbolic",
            callback: Lang.bind(this, this._findAction),
            tooltip_text: _("Locate Device")
        });
        this.pluginBar.actor.add(this.findButton, { expand: true, x_fill: false });
        
        this.browseButton = new ActionButton({
            icon_name: "folder-remote-symbolic",
            callback: Lang.bind(this, this._browseAction),
            toggle_mode: true,
            tooltip_text: _("Browse Files")
        });
        this.pluginBar.actor.add(this.browseButton, { expand: true, x_fill: false });
        
        this.shareButton = new ActionButton({
            icon_name: "send-to-symbolic",
            callback: Lang.bind(this, this._shareAction),
            tooltip_text: _("Send Files")
        });
        this.pluginBar.actor.add(this.shareButton, { expand: true, x_fill: false });
        
        // Browse Bar
        this.browseBar = new PopupMenu.PopupMenuSection({
            reactive: false,
            can_focus: false
        });
        this.browseBar.actor.style_class = "popup-sub-menu";
        this.browseBar.actor.visible = false;
        this.browseButton.bind_property(
            "checked",
            this.browseBar.actor,
            "visible",
            GObject.BindingFlags.DEFAULT
        );
        this.addMenuItem(this.browseBar);
        
        // Status Bar
        this.statusBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.addMenuItem(this.statusBar);
        
        this.statusButton = new ActionButton({
            icon_name: "channel-insecure-symbolic",
            callback: Lang.bind(this, this._statusAction),
            tooltip_text: "" // placeholder, strings in this._statusChanged()
        });
        this.statusBar.actor.add(this.statusButton, { x_fill: false });
        
        this.statusLabel = new St.Label({
            text: "",
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.actor.add(this.statusLabel, { x_expand: true });
        
        // Property signals
        device.connect(
            "changed::battery",
            Lang.bind(this, this._batteryChanged)
        );
        device.connect(
            "notify::name",
            Lang.bind(this, this._nameChanged)
        );
        device.connect(
            "changed::plugins",
            Lang.bind(this, this._pluginsChanged)
        );
        
        // Status signals
        device.connect(
            "notify::reachable",
            Lang.bind(this, this._statusChanged)
        );
        device.connect(
            "notify::trusted",
            Lang.bind(this, this._statusChanged)
        );
        
        manager.connect(
            "notify::scanning",
            Lang.bind(this, this._statusChanged)
        );
        
        // TODO: MConnect doesn't call PropertiesChanged on cached devices?
        this._statusChanged(device);
    },
    
    // Callbacks
    _batteryChanged: function (device, variant) {
        debug("extension.DeviceMenu._batteryChanged(" + variant.deep_unpack() + ")");
        
        let [charging, level] = variant.deep_unpack();
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
        debug("extension.DeviceMenu._nameChanged()");
        
        name = name.deep_unpack();
        this.nameLabel.label.text = (name === "string") ? name : device.name;
    },
    
    _pluginsChanged: function (device, plugins) {
        debug("extension.DeviceMenu._pluginsChanged()");
        
        // Plugin Buttons
        let buttons = {
            findmyphone: this.findButton,
            sftp: this.browseButton,
            share: this.shareButton,
            telephony: this.smsButton
        };
        let sensitive;
        
        for (let name in buttons) {
            sensitive = (device.hasOwnProperty(name));
            buttons[name].can_focus = sensitive;
            buttons[name].reactive = sensitive;
            buttons[name].track_hover = sensitive;
            buttons[name].opacity = sensitive ? 255 : 128;
            
            if (sensitive && name === "sftp") {
                device.mounted = Settings.get_boolean("device-automount");
            }
        }
        
        // Battery Plugin
        if (device.trusted && device.hasOwnProperty("battery")) {
            this._batteryChanged(
                device,
                new GLib.Variant(
                    "(bi)",
                    [device.battery.charging, device.battery.level]
                )
            );
        } else {
            this.batteryIcon.icon_name = "battery-missing-symbolic";
            this.batteryLabel.text = "";
        }
    },
    
    _statusChanged: function (device, state) {
        debug("extension.DeviceMenu._statusChanged(" + this.device.gObjectPath + ")");
        
        let { reachable, trusted } = this.device;
        
        this.pluginBar.actor.visible = (reachable && trusted);
        this.statusBar.actor.visible = (!reachable || !trusted);
        this.batteryIcon.visible = (reachable && trusted);
        
        if (!trusted) {
            this.statusButton.child.icon_name = "channel-insecure-symbolic";
            this.statusButton.tooltip.title = _("Request Pair");
            this.statusLabel.text = _("Device is unpaired");
        } else if (!reachable) {
            this.statusButton.child.icon_name = "view-refresh-symbolic";
            this.statusButton.tooltip.title = _("Attempt Reconnection");
        
            if (this.manager._scans.has(this.device.id)) {
                this.statusLabel.text = _("Attempting to reconnect...");
                this.statusButton.can_focus = false;
                this.statusButton.reactive = false;
                this.statusButton.track_hover = false;
                this.statusButton.opacity = 128;
            } else {
                this.statusLabel.text = _("Device is disconnected");
                this.statusButton.can_focus = true;
                this.statusButton.reactive = true;
                this.statusButton.track_hover = true;
                this.statusButton.opacity = 255;
            }
        }
        
        this._pluginsChanged(this.device);
    },
    
    // Plugin Callbacks
    _browseAction: function (button) {
        debug("extension.DeviceMenu._browseAction()");
        
        if (button.checked) {
            button.add_style_pseudo_class("active");
        } else {
            button.remove_style_pseudo_class("active");
            return;
        }
        
        if (this.device.mount()) {
            this.browseBar.actor.destroy_all_children();
            
            for (let path in this.device.mounts) {
                let mountItem = new PopupMenu.PopupMenuItem(
                    this.device.mounts[path]
                );
                mountItem.path = path;
                
                mountItem.connect("activate", (item) => {
                    button.checked = false;
                    button.remove_style_pseudo_class("active");
                    item._getTopMenu().close(true);
                    GLib.spawn_command_line_async("xdg-open " + item.path);
                });
                
                this.browseBar.addMenuItem(mountItem);
            }
        } else {
            Main.notifyError(
                this.device.name,
                _("Failed to mount device filesystem")
            );
            
            this.browseButton.checked = false;
            this.browseButton.remove_style_pseudo_class("active");
        }
    },
    
    _findAction: function (button) {
        debug("extension.DeviceMenu._findAction()");
        this._getTopMenu().close(true);
        this.device.ring();
    },
    
    _shareAction: function (button) {
        debug("extension.DeviceMenu._shareAction()");
        this._getTopMenu().close(true);
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/share.js --device=" + this.device.id
        );
    },
    
    _smsAction: function (button) {
        debug("extension.DeviceMenu._smsAction()");
        this._getTopMenu().close(true);
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/sms.js --device=" + this.device.id
        );
    },
    
    _statusAction: function (button) {
        debug("extension.DeviceMenu._statusAction()");
        
        if (this.device.trusted) {
            this.manager.scan(this.device.id, 2);
        } else {
            this.device.pair();
        }
    }
});


/** An indicator representing a Device in the Status Area */
var DeviceIndicator = new Lang.Class({
    Name: "DeviceIndicator",
    Extends: PanelMenu.Button,
    
    _init: function (device, manager) {
        this.parent(null, device.name + " Indicator", false);
        
        this.device = device;
        this.manager = manager;
        
        // Device Icon
        this.icon = new St.Icon({
            icon_name: "smartphone-disconnected",
            style_class: "system-status-icon"
        });
        this.actor.add_actor(this.icon);
        
        this.deviceMenu = new DeviceMenu(device, manager);
        this.menu.addMenuItem(this.deviceMenu);
        
        // Signals
        Settings.connect("changed::device-visibility", () => {
            this._sync();
        });
        
        Settings.connect("changed::device-indicators", () => {
            this._sync();
        });
        
        device.connect("notify::reachable", () => { this._sync(); });
        device.connect("notify::trusted", () => { this._sync(); });
        
        // Sync
        this._sync(device);
    },
    
    // Callbacks
    _sync: function (sender, cb_data) {
        debug("extension.DeviceIndicator._sync()");
        
        let flags = Settings.get_flags("device-visibility");
        let { reachable, trusted, type } = this.device;
        
        // Device Visibility
        if (!Settings.get_boolean("device-indicators")) {
            this.actor.visible = false;
        } else if (!(flags & DeviceVisibility.UNPAIRED) && !trusted) {
            this.actor.visible = false;
        } else if (!(flags & DeviceVisibility.OFFLINE) && !reachable) {
            this.actor.visible = false;
        } else {
            this.actor.visible = true;
        }
        
        // Indicator Icon
        let icon = (type === "phone") ? "smartphone" : type;
        
        if (trusted && reachable) {
            this.icon.icon_name = icon + "-connected";
        } else if (trusted) {
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
    Name: "SystemIndicator",
    Extends: PanelMenu.SystemIndicator,
    
    _init: function () {
        this.parent();
        
        this.manager = false;
        this._indicators = {};
        this._menus = {};
        this.keybindingManager = new KeybindingManager();
        this._keybindings = [];
        
        // Notifications
        this._integrateNautilus();
        Settings.connect(
            "changed::nautilus-integration",
            Lang.bind(this, this._integrateNautilus)
        );
        
        // Select the backend service
        if (Settings.get_enum("service-provider") === ServiceProvider.MCONNECT) {
            this._backend = MConnect;
        } else {
            this._backend = KDEConnect;
        }
        
        // System Indicator
        this.extensionIndicator = this._addIndicator();
        this.extensionIndicator.icon_name = "device-link-symbolic";
        let userMenuTray = Main.panel.statusArea.aggregateMenu._indicators;
        userMenuTray.insert_child_at_index(this.indicators, 0);
        
        this.extensionMenu = new PopupMenu.PopupSubMenuMenuItem(
            _("Mobile Devices"),
            true
        );
        this.extensionMenu.icon.icon_name = this.extensionIndicator.icon_name;
        this.menu.addMenuItem(this.extensionMenu);
        
        // Extension Menu -> [ Devices Section ]
        this.devicesSection = new PopupMenu.PopupMenuSection();
        Settings.bind(
            "device-indicators",
            this.devicesSection.actor,
            "visible",
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.extensionMenu.menu.addMenuItem(this.devicesSection);
        
        // Extension Menu -> [ Enable Item ]
        this.enableItem = this.extensionMenu.menu.addAction(
            _("Enable"),
            this._backend.startService
        );
        
        // Extension Menu -> Mobile Settings Item
        this.extensionMenu.menu.addAction(
            _("Mobile Settings"), 
            this._openPrefs
        );
        
        //
        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);
        
        // Watch for DBus service
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            this._backend.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );
        
        // Watch "service-autostart" setting
        Settings.connect("changed::service-autostart", (settings, key) => {
            if (Settings.get_boolean(key) && !this.manager) {
                this._backend.startService();
            }
        });
        
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
    },
    
    // The DBus interface has appeared
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        debug("extension.SystemIndicator._serviceAppeared()");
        
        this.manager = new this._backend.DeviceManager();
        this.enableItem.actor.visible = !(this.manager);
        this.extensionIndicator.visible = (this.manager);
        
        // Extension Menu -> (Stop) Discover Devices Item
        this.scanItem = this.extensionMenu.menu.addAction(
            "", () => { this.manager.scan(); }
        );
        this.extensionMenu.menu.box.set_child_at_index(this.scanItem.actor, 1);
        this.manager.connect("notify::scanning", () => {
            if (this.manager._scans.has("manager")) {
                this.scanItem.label.text = _("Stop Discovering Devices");
            } else {
                this.scanItem.label.text = _("Discover Devices");
            }
        });
        this.manager.notify("scanning");
        
        // Add currently managed devices
        for (let dbusPath of this.manager.devices.keys()) {
            this._deviceAdded(this.manager, dbusPath);
        }
        
        // Watch for new and removed devices
        this.manager.connect(
            "device::added",
            Lang.bind(this, this._deviceAdded)
        );
        
        this.manager.connect(
            "device::removed",
            Lang.bind(this, this._deviceRemoved)
        );
        
        // Persistent Scanning
        Settings.connect(
            "changed::persistent-discovery",
            Lang.bind(this, this._persistentDiscovery)
        );
        
        this._persistentDiscovery();
    },
    
    // The DBus interface has vanished
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        debug("extension.SystemIndicator._serviceVanished()");
        
        if (this.manager) {
            this.manager.destroy();
            this.manager = false;
        }
        
        if (this.scanItem) { this.scanItem.destroy(); }
        
        this.enableItem.actor.visible = !(this.manager);
        this.extensionIndicator.visible = (this.manager);
        
        // Start the service or wait for it to start
        if (Settings.get_boolean("service-autostart")) {
            this._backend.startService();
        } else {
            log("waiting for service");
        }
    },
    
    _extensionKeybindings: function () {
        for (let binding of this._keybindings) {
            this.keybindingManager.remove(binding);
        }
        this._keybindings = [];
    
        let bindings = Settings.get_strv("extension-keybindings");
        
        if (bindings[0].length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    bindings[0],
                    Lang.bind(this, this._openMenu)
                )
            );
        }
        
        if (bindings[1].length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    bindings[1],
                    Lang.bind(this, this._discoverDevices)
                )
            );
        }
        
        if (bindings[2].length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    bindings[2],
                    Lang.bind(this, this._openPrefs)
                )
            );
        }
        
        if (bindings[3].length) {
            this._keybindings.push(
                this.keybindingManager.add(
                    bindings[3],
                    Lang.bind(this, this._backend.startSettings)
                )
            );
        }
    },
    
    _deviceKeybindings: function (indicator) {
        let menu = indicator.deviceMenu;
        let profiles = Settings.get_value("device-keybindings").deep_unpack();
        
        for (let binding of menu._keybindings) {
            this.keybindingManager.remove(binding);
        }
        menu._keybindings = [];
        
        if (profiles.hasOwnProperty(menu.device.id)) {
            let profile = profiles[menu.device.id].deep_unpack();
            let bindings = profile.bindings.deep_unpack();
        
            if (bindings[0].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[0],
                        Lang.bind(this, this._openDeviceMenu, indicator)
                    )
                );
            }
            
            if (bindings[1].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[1], 
                        Lang.bind(menu, menu._smsAction)
                    )
                );
            }
            
            if (bindings[2].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[2], 
                        Lang.bind(menu, menu._findAction)
                    )
                );
            }
            
            if (bindings[3].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[3],
                        Lang.bind(this, this._browseDevice, indicator)
                    )
                );
            }
            
            if (bindings[4].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[4],
                        Lang.bind(menu, menu._shareAction)
                    )
                );
            }
            
            if (bindings[5].length) {
                menu._keybindings.push(
                    this.keybindingManager.add(
                        bindings[5],
                        Lang.bind(menu, menu._statusAction)
                    )
                );
            }
        }
    },
    
    _persistentDiscovery: function () {
        let persist = Settings.get_boolean("persistent-discovery");
    
        if (persist && !this.manager._scans.has("persistent")) {
            this.manager.scan("persistent", 0);
        } else if (!persist && this.manager._scans.has("persistent")) {
            this.manager.scan("persistent", 0);
        }
    },
    
    _discoverDevices: function () {
        if (this.manager) {
            this.manager.scan();
        }
    },
    
    _browseDevice: function (indicator) {
        let menu;
        
        if (Settings.get_boolean("device-indicators")) {
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
    
    _openDeviceMenu: function (indicator) {
        if (Settings.get_boolean("device-indicators")) {
            indicator.menu.toggle();
        } else {
            this._openMenu();
//            Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
//            this.extensionMenu.menu.toggle();
//            indicator.deviceMenu.actor.grab_key_focus();
        }
    },
    
    _openMenu: function () {
        Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
        this.extensionMenu.menu.toggle();
        this.extensionMenu.actor.grab_key_focus();
    },
    
    _openPrefs: function () {
        GLib.spawn_command_line_async(
            "gnome-shell-extension-prefs mconnect@andyholmes.github.io"
        );
    },
    
    _deviceAdded: function (manager, dbusPath) {
        debug("extension.SystemIndicator._deviceAdded(" + dbusPath + ")");
        
        let device = this.manager.devices.get(dbusPath);
        
        // Status Area -> [ Device Indicator ]
        let indicator = new DeviceIndicator(device, manager);
        this._indicators[dbusPath] = indicator;
        Main.panel.addToStatusArea(dbusPath, indicator);
        
        // Extension Menu -> [ Devices Section ] -> Device Menu
        let menu = new DeviceMenu(device, manager);
        this._menus[dbusPath] = menu;
        
        device.connect("notify::reachable", () => {
            this._deviceMenuVisibility(menu);
        });
        device.connect("notify::trusted", () => {
            this._deviceMenuVisibility(menu);
        });
        
        this.devicesSection.addMenuItem(menu);
        this._deviceMenuVisibility(menu);
        
        // Keybindings
        this._deviceKeybindings(indicator);
    },
    
    _deviceRemoved: function (manager, dbusPath) {
        debug("extension.SystemIndicator._deviceRemoved(" + dbusPath + ")");
        
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
        let flags = Settings.get_flags("device-visibility");
        let { reachable, trusted } = menu.device;
        
        if (!(flags & DeviceVisibility.UNPAIRED) && !trusted) {
            menu.actor.visible = false;
        } else if (!(flags & DeviceVisibility.OFFLINE) && !reachable) {
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
        let script = dir.get_child("nautilus-send-mconnect.py");
        let scriptExists = script.query_exists(null);
        let integrate = Settings.get_boolean("nautilus-integration");
        
        if (integrate && !scriptExists) {
            if (!dir.query_exists(null)) {
                GLib.mkdir_with_parents(path, 493); // 0755 in octal
            }
            
            script.make_symbolic_link(
                Me.path + "/nautilus-send-mconnect.py",
                null,
                null
            );
            this._notifyNautilus();
        } else if (!integrate && scriptExists) {
            script.delete(null);
            this._notifyNautilus();
        }
    },
    
    destroy: function () {
        if (this.manager) {
            this.manager.destroy();
            this.manager = false;
        }
        
        for (let dbusPath in this._indicators) {
            this._deviceRemoved(this.manager, dbusPath);
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
    debug("initializing extension");
    
    initTranslations();
    Gtk.IconTheme.get_default().add_resource_path("/icons");
}

function enable() {
    debug("enabling extension");
    
    systemIndicator = new SystemIndicator();
    
    Settings.connect("changed::service-provider", () => {
        systemIndicator.destroy();
        systemIndicator = new SystemIndicator();
    });
}

function disable() {
    debug("disabling extension");
    
    GObject.signal_handlers_destroy(Settings);
    systemIndicator.destroy();
}

