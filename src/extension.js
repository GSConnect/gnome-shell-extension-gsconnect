'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// Bootstrap
window.gsconnect = {
    datadir: imports.misc.extensionUtils.getCurrentExtension().path
};
imports.searchPath.unshift(gsconnect.datadir);
imports._gsconnect;

// Local Imports
const _ = gsconnect._;
const DBus = imports.modules.dbus;
const Device = imports.shell.device;
const DoNotDisturb = imports.shell.donotdisturb;
const Keybindings = imports.shell.keybindings;


const ServiceProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface(gsconnect.app_id)
);


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
class ServiceIndicator extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._devices = {};
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

        // FIXME finish donotdisturb stuff
        // Do Not Disturb Item
        this.dndItem = new DoNotDisturb.MenuItem();
        this.extensionMenu.menu.addMenuItem(this.dndItem);

        this.extensionMenu.menu.addAction(_('Mobile Settings'), () => {
            this.service.OpenSettings();
        });

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
        return Object.values(this._devices);
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

    _setupObjManager(obj, res) {
        this.manager = Gio.DBusObjectManagerClient.new_finish(res);

        this._startService();

        // Setup currently managed objects
        for (let obj of this.manager.get_objects()) {
            for (let iface of obj.get_interfaces()) {
                this._onInterfaceAdded(this.manager, obj, iface);
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
        this._nameOwnerId = this.manager.connect(
            'notify::name-owner',
            this._onNameOwnerChanged.bind(this)
        );
    }

    _startService() {
        let path = gsconnect.datadir + '/service/daemon.js';

        if (this.service || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return;
        }

        new ServiceProxy({
            g_connection: Gio.DBus.session,
            g_name: gsconnect.app_id,
            g_object_path: gsconnect.app_path
        }).init_promise().then(service => {
            this.service = service;
            this.devices.map(device => { device.service = service; });
            this.extensionIndicator.visible = true;
        }).catch(debug);
    }

    _onNameOwnerChanged() {
        debug(`${this.manager.name_owner}`);

        if (this.manager.name_owner === null) {
            // Destroy any device proxies
            for (let iface of Object.values(this._devices)) {
                this._onInterfaceRemoved(this.manager, iface.get_object(), iface);
            }

            if (this.service) {
                this.service.destroy();
                delete this.service;
                this.extensionIndicator.visible = false;
            }
        }

        this._startService();
    }

    _onInterfaceAdded(manager, object, iface) {
        let info = gsconnect.dbusinfo.lookup_interface(iface.g_interface_name);

        // We only setup properties for GSConnect interfaces
        if (info) {
            DBus.proxyProperties(iface, info);
        }

        // It's a device
        if (iface.g_interface_name === 'org.gnome.Shell.Extensions.GSConnect.Device') {
            log(`GSConnect: Adding ${iface.Name}`);

            this._devices[iface.Id] = iface;

            // GActions
            iface.gactions = Gio.DBusActionGroup.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );
            iface.gactions.list_actions();

            // GMenu
            iface.gmenu = Gio.DBusMenuModel.get(
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
                path: `/org/gnome/shell/extensions/gsconnect/device/${iface.Id}/`
            });

            iface.service = this.service;

            // Keyboard Shortcuts
            iface._keybindingsId = iface.settings.connect(
                'changed::keybindings',
                this._deviceKeybindings.bind(this, iface)
            );
            this._deviceKeybindings(iface);

            // Currently we only setup methods for Device interfaces, and
            // we only really use it for Activate() and OpenSettings()
            DBus.proxyMethods(iface, info);

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
            iface.Activate();
        }
    }

    _onInterfaceRemoved(manager, object, iface) {
        debug(iface.g_interface_name);

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

            delete this._devices[iface.Id];
        }
    }

    /**
     * Setup device keybindings
     */
    _deviceKeybindings(iface) {
        // Reset grabbed accelerators
        if (iface.hasOwnProperty('_keybindings')) {
            iface._keybindings.map(id => this.keybindingManager.remove(id));
        }

        iface._keybindings = [];

        let keybindings = gsconnect.full_unpack(
            iface.settings.get_value('keybindings')
        );

        // Backwards compatible check for old keybindings
        if (typeof keybindings === 'string') {
            iface.settings.set_value(
                'keybindings',
                new GLib.Variant('a{sv}', {})
            );
            return;
        }

        for (let name in keybindings) {
            let action = this.keybindingManager.add(
                keybindings[name],
                () => iface.gactions.activate_action(name, null)
            );

            if (action !== 0) {
                iface._keybindings.push(action);
            }
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
        id = id.split('|');
        let deviceId = id.splice(0, 1)[0];
        id = id.join('|');

        if (serviceIndicator._devices[deviceId]) {
            let device = serviceIndicator._devices[deviceId];
            device.gactions.activate_action(
                'closeNotification',
                gsconnect.full_pack(id)
            );
        }
    }

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
        this.manager.disconnect(this._nameOwnerId);

        // Destroy any device proxies
        for (let iface of Object.values(this._devices)) {
            this._onInterfaceRemoved(this.manager, iface.get_object(), iface);
        }

        this.keybindingManager.destroy();

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

    if (this._appId === 'org.gnome.Shell.Extensions.GSConnect') {
        // Look for the GNotification id
        for (let id in this._notifications) {
            if (this._notifications[id] === notification) {
                debug('connecting to shell notification: ' + id);

                // Close the notification remotely when dismissed
                notification.connect('destroy', (notification, reason) => {
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
    debug('initializing extension');

    // TODO: restore prototype???
    NotificationDaemon.GtkNotificationDaemonAppSource.prototype.pushNotification = pushNotification;
};


function enable() {
    log('Enabling GSConnect');

    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path + '/icons');
    serviceIndicator = new ServiceIndicator();
};


function disable() {
    log('Disabling GSConnect');

    serviceIndicator.destroy();
    serviceIndicator = null;
};

