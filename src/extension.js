'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// Bootstrap
window.gsconnect = {
    extdatadir: imports.misc.extensionUtils.getCurrentExtension().path
};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const _ = gsconnect._;
const DBus = imports.modules.dbus;
const Device = imports.shell.device;
const DoNotDisturb = imports.shell.donotdisturb;
const Keybindings = imports.shell.keybindings;
const Notification = imports.shell.notification;


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
class ServiceIndicator extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._devices = new Set();
        this._menus = {};

        this.keybindingManager = new Keybindings.Manager();

        // Extension Indicator
        this.extensionIndicator = this._addIndicator();
        this.extensionIndicator.icon_name = 'org.gnome.Shell.Extensions.GSConnect-symbolic';
        let userMenuTray = Main.panel.statusArea.aggregateMenu._indicators;
        userMenuTray.insert_child_at_index(this.indicators, 0);

        // Extension Menu
        this.extensionMenu = new PopupMenu.PopupSubMenuMenuItem(
            _('Mobile Devices'),
            true
        );
        this.extensionMenu.icon.icon_name = this.extensionIndicator.icon_name;
        this.menu.addMenuItem(this.extensionMenu);

        // Devices Section
        this.devicesSection = new PopupMenu.PopupMenuSection();
        gsconnect.settings.bind(
            'show-indicators',
            this.devicesSection.actor,
            'visible',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.extensionMenu.menu.addMenuItem(this.devicesSection);

        // "Do Not Disturb" Item
        this.extensionMenu.menu.addMenuItem(new DoNotDisturb.MenuItem());

        // "Mobile Settings" Item
        this.extensionMenu.menu.addAction(
            _('Mobile Settings'),
            () => this.service.activate_action('openSettings', null)
        );

        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);

        // Menu Visibility
        this._gsettingsId = gsconnect.settings.connect('changed', () => {
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
            this._setupObjManager.bind(this)
        );
    }

    get devices() {
        return this._devices;
    }

    _sync(menu) {
        let { Connected, Paired } = menu.device;

        if (!Paired && !gsconnect.settings.get_boolean('show-unpaired')) {
            menu.actor.visible = false;
        } else if (!Connected && !gsconnect.settings.get_boolean('show-offline')) {
            menu.actor.visible = false;
        } else {
            menu.actor.visible = true;
        }
    }

    async _setupObjManager(obj, res) {
        this.manager = Gio.DBusObjectManagerClient.new_finish(res);

        await this._startService();

        // Setup currently managed objects
        for (let object of this.manager.get_objects()) {
            for (let iface of object.get_interfaces()) {
                this._onInterfaceAdded(this.manager, object, iface);
            }
        }

        // Watch for new and removed
        this._interfaceAddedId = this.manager.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );
        this._interfaceRemovedId = this.manager.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );
        this._objectRemovedId = this.manager.connect(
            'object-removed',
            this._onObjectRemoved.bind(this)
        );
        this._nameOwnerId = this.manager.connect(
            'notify::name-owner',
            this._onNameOwnerChanged.bind(this)
        );
    }

    async _startService() {
        // Prevent a hard hang if trying to start the service after it's been
        // uninstalled.
        let path = gsconnect.extdatadir + '/service/daemon.js';

        if (this.service || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return;
        }

        this.service = Gio.DBusActionGroup.get(
            Gio.DBus.session,
            gsconnect.app_id,
            gsconnect.app_path
        );

        await this.service.list_actions();
        this.extensionIndicator.visible = true;
    }

    _onNameOwnerChanged() {
        if (this.manager.name_owner === null) {
            debug(`Service Stopped`);

            // Destroy any device proxies
            for (let iface of this.devices) {
                this._onInterfaceRemoved(this.manager, iface.get_object(), iface);
            }

            if (this.service) {
                delete this.service;
                this.extensionIndicator.visible = false;
            }
        }

        this._startService();
    }

    async _onInterfaceAdded(manager, object, iface) {
        let info = gsconnect.dbusinfo.lookup_interface(iface.g_interface_name);

        // We only setup properties for GSConnect interfaces
        if (info) {
            DBus.proxyProperties(iface, info);
        }

        // It's a device
        if (iface.g_interface_name === 'org.gnome.Shell.Extensions.GSConnect.Device') {
            log(`GSConnect: Adding ${iface.Name}`);

            this.devices.add(iface);

            // GActions
            iface.action_group = Gio.DBusActionGroup.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );

            // GMenu
            iface.menu_model = Gio.DBusMenuModel.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );

            // GSettings
            iface.settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device',
                    true
                ),
                path: '/org/gnome/shell/extensions/gsconnect/device/' + iface.Id + '/'
            });

            // Keyboard Shortcuts
            iface._keybindingsId = iface.settings.connect(
                'changed::keybindings',
                this._deviceKeybindings.bind(this, iface)
            );
            this._deviceKeybindings(iface);

            // Device Indicator
            let indicator = new Device.Indicator(object, iface);
            Main.panel.addToStatusArea(iface.g_object_path, indicator);

            // Device Menu
            let menu = new Device.Menu(object, iface);
            this._menus[iface.g_object_path] = menu;

            this.devicesSection.addMenuItem(menu);
            this._sync(menu);

            // Properties
            iface._propertiesId = iface.connect(
                'g-properties-changed',
                this._sync.bind(this, menu)
            );

            // Try activating the device
            iface.action_group.activate_action('activate', null);
        }
    }

    async _onInterfaceRemoved(manager, object, iface) {
        if (iface.g_interface_name === 'org.gnome.Shell.Extensions.GSConnect.Device') {
            log(`GSConnect: Removing ${iface.Name}`);

            // Disconnect properties
            iface.disconnect(iface._propertiesId);

            // Disconnect keybindings
            iface.settings.disconnect(iface._keybindingsId);
            iface._keybindings.map(id => this.keybindingManager.remove(id));

            // Destroy the indicator
            Main.panel.statusArea[iface.g_object_path].destroy();

            // Destroy the menu
            this._menus[iface.g_object_path].destroy();
            delete this._menus[iface.g_object_path];

            this.devices.delete(iface);
        }
    }

    // FIXME: The device's DBusObject is unexported in Device.destroy() before
    // the 'interface-removed' handler is resolved, so for now we catch it here.
    async _onObjectRemoved(manager, object) {
        for (let iface of this.devices) {
            if (iface.g_object_path === object.g_object_path) {
                this._onInterfaceRemoved(manager, object, iface);
            }
        }
    }

    /**
     * Setup device keybindings
     */
    async _deviceKeybindings(iface) {
        // Reset grabbed accelerators
        if (iface.hasOwnProperty('_keybindings')) {
            iface._keybindings.map(id => this.keybindingManager.remove(id));
        }

        iface._keybindings = [];

        let keybindings = DBus.full_unpack(
            iface.settings.get_value('keybindings')
        );

        // TODO: Backwards compatible check for keybindings <= v12
        if (typeof keybindings === 'string') {
            iface.settings.set_value(
                'keybindings',
                new GLib.Variant('a{sv}', {})
            );
            return;
        }

        for (let action in keybindings) {
            let [ok, name, parameter] = Gio.Action.parse_detailed_name(action);

            let actionId = this.keybindingManager.add(
                keybindings[action],
                () => iface.action_group.activate_action(name, parameter)
            );

            if (actionId !== 0) {
                iface._keybindings.push(actionId);
            }
        }
    }

    // TODO: need hardcoded keybinding for this
    _openDeviceMenu(indicator) {
        if (gsconnect.settings.get_boolean('show-indicators')) {
            indicator.menu.toggle();
        } else {
            Main.panel._toggleMenu(Main.panel.statusArea.aggregateMenu);
            this.extensionMenu.menu.toggle();
            this.extensionMenu.actor.grab_key_focus();
        }
    }

    destroy() {
        // Unhook from any ObjectManager events
        this.manager.disconnect(this._interfaceAddedId);
        this.manager.disconnect(this._interfaceRemovedId);
        this.manager.disconnect(this._objectRemovedId);
        this.manager.disconnect(this._nameOwnerId);

        // Destroy any device proxies
        for (let iface of this.devices) {
            this._onInterfaceRemoved(this.manager, iface.get_object(), iface);
        }

        // Disconnect any keybindings
        this.keybindingManager.destroy();

        // Disconnect from any GSettings changes
        gsconnect.settings.disconnect(this._gsettingsId);

        // Destroy the UI
        this.extensionMenu.destroy();
        this.indicators.destroy();
        this.menu.destroy();
    }
}


var serviceIndicator = null;


function init() {
    debug('Initializing GSConnect');

    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path + '/icons');

    // If installed as a user extension, this will install the Desktop entry,
    // DBus and systemd service files necessary for DBus activation and
    // GNotifications. Since there's no uninit()/uninstall() hook for extensions
    // and they're only used *by* GSConnect, they should be okay to leave.
    gsconnect.installService();

    // These modify the notification source for GSConnect's GNotifications and
    // need to be active even when the extension is disabled (eg. lock screen).
    // Since they *only* affect notifications from GSConnect, it should be okay
    // to leave them applied.
    Notification.patchGSConnectNotificationSource();
    Notification.patchGtkNotificationDaemon();
}


function enable() {
    log('Enabling GSConnect');

    serviceIndicator = new ServiceIndicator();
    Notification.patchGtkNotificationSources();
}


function disable() {
    log('Disabling GSConnect');

    serviceIndicator.destroy();
    serviceIndicator = null;
    Notification.unpatchGtkNotificationSources();
}

