"use strict";

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
const ModalDialog = imports.ui.modalDialog;
const NotificationDaemon = imports.ui.notificationDaemon;
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


/**
 * Keyboard shortcuts
 *
 * References:
 *     https://developer.gnome.org/meta/stable/MetaDisplay.html
 *     https://developer.gnome.org/meta/stable/meta-MetaKeybinding.html
 */
class KeybindingManager {

    constructor(devices) {
        this.bindings = new Map();

        this._acceleratorId = global.display.connect(
            "accelerator-activated",
            (display, action, deviceId, timestamp) => {
                if (this.bindings.has(action)) {
                    this.bindings.get(action).callback()
                }
            }
        );
    }

    add(accelerator, callback) {
        debug(arguments);

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
            debug(`Failed to grab accelerator "${accelerator}"`);
        }

        return action;
    }

    remove(action) {
        if (action !== 0) {
            let binding = this.bindings.get(action);

            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(binding.name, Shell.ActionMode.NONE);
            this.bindings.delete(action);
        }
    }

    removeAll() {
        for (let action of this.bindings.keys()) {
            this.remove(action);
        }
    }

    destroy() {
        this.removeAll();
        global.display.disconnect(this._acceleratorId);
    }
}


/** ... FIXME FIXME FIXME */
class DoNotDisturbItem extends PopupMenu.PopupSwitchMenuItem {

    _init() {
        super._init(_('Do Not Disturb'), false);

        // Update the toggle state when 'paintable'
        this.actor.connect('notify::mapped', () => {
            let now = GLib.DateTime.new_now_local().to_unix();
            this.setToggleState(gsconnect.settings.get_int('donotdisturb') > now);
        });

        this.connect('toggled', () => {
            // The state has already been changed when this is emitted
            if (this.state) {
                let dialog = new DoNotDisturbDialog();
                dialog.open();
            } else {
                gsconnect.settings.set_int('donotdisturb', 0);
            }

            this._getTopMenu().close(true);
        });
    }
}


class DoNotDisturbDialog extends Actors.Dialog {

    _init() {
        super._init({
            icon: 'preferences-system-time-symbolic',
            title: _('Do Not Disturb'),
            subtitle: _('Silence Mobile Device Notifications')
        });

        //
        this._time = 1*60*60; // 1 hour in seconds

        this.permButton = new Actors.RadioButton({
            text: _('Until you turn this off')
        });
        this.content.add(this.permButton);

        // Duration Timer
        this.timerWidget = new St.BoxLayout({
            vertical: false,
            x_expand: true
        });

        let now = GLib.DateTime.new_now_local();
        this.timerLabel = new St.Label({
            text: _('Until %s (%s)').format(
                Util.formatTime(now.add_seconds(this._time)),
                this._getDurationLabel()
            ),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 6px;'
        });
        this.timerWidget.add_child(this.timerLabel);

        this.minusTime = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({
                icon_name: 'list-remove-symbolic',
                icon_size: 16
            })
        });
        this.minusTime.connect('clicked', this._minusTime.bind(this));
        this.timerWidget.add_child(this.minusTime);

        this.plusTime = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({
                icon_name: 'list-add-symbolic',
                icon_size: 16
            })
        });
        this.plusTime.connect('clicked', this._plusTime.bind(this));
        this.timerWidget.add_child(this.plusTime);

        this.timerButton = new Actors.RadioButton({
            widget: this.timerWidget,
            group: this.permButton.group,
            active: true
        });
        this.content.add(this.timerButton);

        // Dialog Buttons
        this.setButtons([
            { label: _('Cancel'), action: this._cancel.bind(this), default: true },
            { label: _('Done'), action: this._done.bind(this) }
        ]);
    }

    _cancel() {
        gsconnect.settings.set_int('donotdisturb', 0);
        this.close();
    }

    _done() {
        let time;

        if (this.timerButton.active) {
            let now = GLib.DateTime.new_now_local();
            time = now.add_seconds(this._time).to_unix();
        } else {
            time = GLib.MAXINT32;
        }

        gsconnect.settings.set_int('donotdisturb', time);
        this.close();
    }

    _minusTime() {
        if (this._time <= 60*60) {
            this._time -= 15*60;
        } else {
            this._time -= 60*60;
        }

        this._setTimeLabel();
    }

    _plusTime() {
        if (this._time < 60*60) {
            this._time += 15*60;
        } else {
            this._time += 60*60;
        }

        this._setTimeLabel();
    }

    _getDurationLabel() {
        if (this._time >= 60*60) {
            let hours = this._time / 3600;
            return gsconnect.ngettext('%d Hour', '%d Hours', hours).format(hours);
        } else {
            return _('%d Minutes').format(this._time / 60);
        }
    }

    _setTimeLabel() {
        this.minusTime.reactive = (this._time > 15*60);
        this.plusTime.reactive = (this._time < 12*60*60);

        let now = GLib.DateTime.new_now_local();
        this.timerLabel.text = _('Until %s (%s)').format(
            Util.formatTime(now.add_seconds(this._time)),
            this._getDurationLabel()
        );
    }
}


/**
 * A PopupMenu used as an information and control center for a device
 */
class DeviceMenu extends PopupMenu.PopupMenuSection {

    _init(object, iface) {
        super._init();

        this.object = object;
        this.device = iface;
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
        this.titleBar = new St.BoxLayout({
            style_class: "gsconnect-title-bar"
        });
        this.controlBox.add_child(this.titleBar);

        // Title Bar -> Device Name
        this.nameLabel = new St.Label({
            style_class: "gsconnect-device-name",
            text: this.device.Name
        });
        this.titleBar.add_child(this.nameLabel);

        // Title Bar -> Separator
        let nameSeparator = new St.Widget({
            style_class: "popup-separator-menu-item gsconnect-title-separator",
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.titleBar.add_child(nameSeparator);

        // Title Bar -> Device Battery
        this.deviceBattery = new Actors.DeviceBattery(object, iface);
        this.titleBar.add_child(this.deviceBattery);

        // Plugin Bar
        // FIXME FIXME FIXME: this needs to be a flowbox now
        this.pluginBar = new St.BoxLayout({
            style_class: "gsconnect-plugin-bar"
        });
        this.controlBox.add_child(this.pluginBar);

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
//                this.sftpButton.checked = false;
//                this.runcommandButton.checked = false;
//                this.listPanel.actor.visible = false;
            }
        });
        this.addMenuItem(this.listPanel);

        // GActions
        this._gactions = Gio.DBusActionGroup.get(
            this.device.g_connection,
            this.device.g_name,
            this.device.g_object_path
        );
        this._gactionsId = [];

        for (let signal of ["enabled-changed", "added", "removed"]) {
            this._gactionsId.push(
                this._gactions.connect("action-" + signal, this._syncItems.bind(this))
            );
        }

        this._buttons = {};

        this.actor.connect("notify::visible", this._sync.bind(this));

        // Watch GSettings & Properties
        this._gsettingsId = gsconnect.settings.connect("changed", this._sync.bind(this));
        this._propertiesId = this.device.connect("g-properties-changed", this._sync.bind(this));

        // GMenu
        this._gmenu = Gio.DBusMenuModel.get(
            this.device.g_connection,
            this.device.g_name,
            this.device.g_object_path
        );

        this._gmenuId = this._gmenu.connect("items-changed", this._syncItems.bind(this));

        // Init
        this._syncItems();
        this._sync(this.device);
    }

    // TODO: sortable buttons...gsettings? dnd?
    _sort() {
    }

    // TODO: destroy withdrawn items
    _syncItems() {
        for (let item of this._gmenu) {
            if (!this._buttons[item.action]) {
                this._buttons[item.action] = new Actors.MenuButton({
                    gmenu: this._gmenu,
                    gactions: this._gactions,
                    item: item
                });
                this._buttons[item.action].connect("clicked", () => {
                    this._getTopMenu().close(null);
                });

                this.pluginBar.add_child(this._buttons[item.action]);
            }

            this._buttons[item.action].visible = this._gactions.get_action_enabled(
                item.action
            );
        }
    }

    _sync() {
        debug(`${this.device.Name} (${this.device.Id})`);

        if (!this.actor.visible) { return; }

        let { Connected, Paired } = this.device;

        // Title Bar
        this.nameLabel.text = this.device.Name;

        // TODO: might as well move this to actors.js
        if (Connected && Paired && gsconnect.settings.get_boolean("show-battery")) {
            this.deviceBattery.visible = true;
            //this.deviceBattery.update();
        } else {
            this.deviceBattery.visible = false;
        }

        // Plugin/Status Bar visibility
        this.pluginBar.visible = (Connected && Paired);
        this.statusBar.visible = (!Connected || !Paired);

        if (!Connected) {
            this.statusLabel.text = _("Device is disconnected");
        } else if (!Paired) {
            this.statusLabel.text = _("Device is unpaired");
        }
    }

    destroy() {
        this._gactionsId.map(id => this.device.actions.disconnect(id));
        this._gmenu.disconnect(this._gmenuId);

        this.device.disconnect(this._propertiesId);
        gsconnect.settings.disconnect(this._gsettingsId);

        PopupMenu.PopupMenuSection.prototype.destroy.call(this);
    }
}


/** An indicator representing a Device in the Status Area */
class DeviceIndicator extends PanelMenu.Button {

    _init(object, iface) {
        super._init(null, `${iface.Name} Indicator`, false);

        this.object = object;
        this.device = iface;

        // Device Icon
        this.icon = new St.Icon({
            icon_name: this.device.SymbolicIconName,
            style_class: "system-status-icon"
        });
        this.actor.add_actor(this.icon);

        // Menu
        this.deviceMenu = new DeviceMenu(object, iface);
        this.menu.addMenuItem(this.deviceMenu);

        // Watch GSettings & Properties
        this._gsettingsId = gsconnect.settings.connect("changed", this._sync.bind(this));
        this._propertiesId = this.device.connect("g-properties-changed", this._sync.bind(this));

        this._sync();
    }

    _sync() {
        debug(`${this.device.Name} (${this.device.Id})`);

        let { Connected, Paired } = this.device;

        // Device Indicator Visibility
        if (!gsconnect.settings.get_boolean("show-indicators")) {
            this.actor.visible = false;
        } else if (!Paired && !gsconnect.settings.get_boolean("show-unpaired")) {
            this.actor.visible = false;
        } else if (!Connected && !gsconnect.settings.get_boolean("show-offline")) {
            this.actor.visible = false;
        } else {
            this.actor.visible = true;
        }

        this.icon.icon_name = this.device.SymbolicIconName;
    }

    destroy() {
        this.device.disconnect(this._propertiesId);
        gsconnect.settings.disconnect(this._gsettingsId);

        PanelMenu.Button.prototype.destroy.call(this);
    }
}


var ServiceProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface(gsconnect.app_id)
);


// TODO: better
function _proxyMethods(info, iface) {
    info.methods.map(method => {
        iface[method.name] = function () {
            iface.call(method.name, null, 0, -1, null, (proxy, res) => {
                let ret;

                try {
                    ret = this.call_finish(res);
                } catch (e) {
                    debug(`Error calling ${method.name} on ${proxy.g_object_path}: ${e.message}`);
                }

                // If return has single arg, only return that or null
                if (method.out_args.length === 1) {
                    (ret) ? ret.deep_unpack()[0] : null;
                // Otherwise return an array (possibly empty)
                } else {
                    (ret) ? ret.deep_unpack() : [];
                }
            });
        };
    });
};


// TODO: better
function _proxyProperties(info, iface) {
    info.properties.map(property => {
        Object.defineProperty(iface, property.name, {
            get: () => {
                return gsconnect.full_unpack(
                    iface.get_cached_property(property.name)
                );
            },
            //set: (value) => iface.set_cached_property(property.name, value),
            configurable: true,
            enumerable: true
        });
    });
};


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
var ServiceIndicator = class ServiceIndicator extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._devices = {};
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

        // FIXME finish donotdisturb stuff
        // Do Not Disturb Item
        this.dndItem = new DoNotDisturbItem();
        this.extensionMenu.menu.addMenuItem(this.dndItem);

        this.extensionMenu.menu.addAction(_("Mobile Settings"), () => {
            this.service.OpenSettings();
        });

        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);

        // Menu Visibility
        this._gsettingsId = gsconnect.settings.connect("changed", () => {
            for (let dbusPath in this._menus) {
                this._sync(this._menus[dbusPath]);
            }
        });

        // org.freedesktop.ObjectManager
        Gio.DBusObjectManagerClient.new(
            Gio.DBus.session,
            Gio.DBusObjectManagerClientFlags.NONE,
            gsconnect.app_id,
            gsconnect.app_path,
            null,
            null,
            (obj, res) => {
                this.manager = Gio.DBusObjectManagerClient.new_finish(res);
                this._setupObjManager();
            }
        );
    }

    get devices() {
        return Object.values(this._devices);
    }

    _sync(menu) {
        let { Connected, Paired } = menu.device;

        if (!Paired && !gsconnect.settings.get_boolean("show-unpaired")) {
            menu.actor.visible = false;
        } else if (!Connected && !gsconnect.settings.get_boolean("show-offline")) {
            menu.actor.visible = false;
        } else {
            menu.actor.visible = true;
        }
    }

    _setupObjManager() {
        if (!this.service) {
            this._startService();
        }

        // Setup currently managed objects
        for (let obj of this.manager.get_objects()) {
            for (let iface of obj.get_interfaces()) {
                this._interfaceAdded(this.manager, obj, iface);
            }
        }

        // Watch for new and removed
        this.manager.connect("interface-added", this._interfaceAdded.bind(this));
        this.manager.connect("interface-removed", this._interfaceRemoved.bind(this));
        this.manager.connect("notify::name-owner", this._onNameOwnerChanged.bind(this));
    }

    _startService() {
        this.service = new ServiceProxy({
            g_connection: Gio.DBus.session,
            g_name: gsconnect.app_id,
            g_object_path: gsconnect.app_path
        });
        this.service.init(null);

        this.devices.map(device => { device.service = this.service; });

        this.extensionIndicator.visible = true;
    }

    _onNameOwnerChanged() {
        debug(`${this.manager.name_owner}`);

        if (this.manager.name_owner === null) {
            // Destroy any device proxies
            for (let path in this._indicators) {
                debug("name-owner destroy");

                this._indicators[path].destroy();
                this._menus[path].destroy();
                delete this._indicators[path];
                delete this._menus[path];
            }

            if (this.service) {
                this.service.destroy();
                delete this.service;
                this.extensionIndicator.visible = false;
            }
        }

        if (!this.service) {
            this._startService();
        }
    }

    _interfaceAdded(manager, object, iface) {
        let info = gsconnect.dbusinfo.lookup_interface(iface.g_interface_name);

        // We only setup properties for GSConnect interfaces
        if (info) {
            _proxyProperties(info, iface);
        }

        // It's a device
        if (iface.g_interface_name === "org.gnome.Shell.Extensions.GSConnect.Device") {
            log(`GSConnect: Adding ${iface.Name}`);

            this._devices[iface.Id] = iface;

            iface.actions = Gio.DBusActionGroup.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );
            iface.service = this.service;

            // Currently we only setup methods for Device interfaces, and
            // we only really use it for activate() and openSettings()
            _proxyMethods(info, iface);

            // Device Indicator
            let indicator = new DeviceIndicator(object, iface);
            this._indicators[iface.g_object_path] = indicator;
            Main.panel.addToStatusArea(iface.g_object_path, indicator);

            // Device Menu
            let menu = new DeviceMenu(object, iface);
            this._menus[iface.g_object_path] = menu;

            this.devicesSection.addMenuItem(menu);
            this._sync(menu);

            // Properties
            iface.connect("g-properties-changed", () => this._sync(menu));

            // Try activating the device
            iface.Activate();
        }
    }

    _interfaceRemoved(manager, object, iface) {
        debug(iface.g_interface_name);

        if (iface.g_interface_name === "org.gnome.Shell.Extensions.GSConnect.Device") {
            log(`GSConnect: Removing ${iface.Name}`);

            this._indicators[iface.g_object_path].destroy();
            this._menus[iface.g_object_path].destroy();

            delete this._devices[iface.id];
            delete this._indicators[iface.g_object_path];
            delete this._menus[iface.g_object_path];
        }
    }

    /**
     * This is connected to the Shell notification's destroy signal by
     * overriding MessageTray.Source.pushNotification().
     *
     * TODO:
     * If the session state has changed the daemon should have already stopped
     * and the remote notification shouldn't be closed.
     */
    _onNotificationDestroyed(id) {
        if (!serviceIndicator || !id) { return; }

        debug(id);

        // Separate the device id from the notification id
        id = id.split("|");
        let deviceId = id.splice(0, 1)[0];
        id = id.join("|");

        if (serviceIndicator._devices[deviceId]) {
            let device = serviceIndicator._devices[deviceId];
            if (device.actions.get_action_enabled("closeNotification")) {
                device.actions.activate_action(
                    "closeNotification",
                    gsconnect.full_pack(id)
                );
            }
        }
    }

    _openDeviceMenu(indicator) {
        if (gsconnect.settings.get_boolean("show-indicators")) {
            indicator.menu.toggle();
        } else {
            Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
            this.extensionMenu.menu.toggle();
            this.extensionMenu.actor.grab_key_focus();
        }
    }

    destroy() {
        // Unhook from any ObjectManager events
        GObject.signal_handlers_destroy(this.manager);

        // Destroy any device proxies
        for (let path in this._indicators) {
            this._indicators[path].destroy();
            this._menus[path].destroy();
            delete this._indicators[path];
            delete this._menus[path];
        }

        // Disconnect from any GSettings changes
        gsconnect.settings.disconnect(this._gsettingsId);

        // Destroy the UI
        this.extensionMenu.destroy();
        this.indicators.destroy();
        this.menu.destroy();
    }
}


/**
 * Monkey-patch for Gnome Shell notifications
 *
 * This removes the notification limit (3) for GSConnect and connects DISMISSED
 * events to the notification plugin so closing Shell notifications works as
 * expected.
 */
var pushNotification = function (notification) {
    if (this.notifications.indexOf(notification) >= 0)
        return;

    if (this._appId === "org.gnome.Shell.Extensions.GSConnect") {
        // Look for the GNotification id
        for (let id in this._notifications) {
            if (this._notifications[id] === notification) {
                debug("connecting to shell notification: " + id);

                // Close the notification remotely when dismissed
                notification.connect("destroy", (notification, reason) => {
                    if (reason === MessageTray.NotificationDestroyedReason.DISMISSED) {
                        serviceIndicator._onNotificationDestroyed(id);
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

    notification.connect('destroy', this._onNotificationDestroy.bind(this));
    notification.connect('acknowledged-changed', this.countUpdated.bind(this));
    this.notifications.push(notification);
    this.emit('notification-added', notification);

    this.countUpdated();
};


var serviceIndicator = null;


function init() {
    debug("initializing extension");

    // TODO: restore prototype???
    NotificationDaemon.GtkNotificationDaemonAppSource.prototype.pushNotification = pushNotification;
};


function enable() {
    debug("enabling extension");

    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);
    serviceIndicator = new ServiceIndicator();
};


function disable() {
    debug("disabling extension");

    serviceIndicator.destroy();
    serviceIndicator = null;
};

