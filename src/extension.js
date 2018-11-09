'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const AggregateMenu = Main.panel.statusArea.aggregateMenu;

// Bootstrap
window.gsconnect = {
    extdatadir: imports.misc.extensionUtils.getCurrentExtension().path
};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const _ = gsconnect._;
const Device = imports.shell.device;
const DoNotDisturb = imports.shell.donotdisturb;
const Keybindings = imports.shell.keybindings;
const Notification = imports.shell.notification;


gsconnect.proxyProperties = function (iface) {
    let info = gsconnect.dbusinfo.lookup_interface(iface.g_interface_name);

    for (let property of info.properties) {
        // Properties already defined for this proxy
        if (iface.hasOwnProperty(property.name)) return;

        Object.defineProperty(iface, property.name, {
            get: () => {
                try {
                    return iface.get_cached_property(property.name).deep_unpack();
                } catch (e) {
                    return null;
                }
            },
            enumerable: true
        });
    }
};


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
class ServiceIndicator extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._activating = false;
        this._cancellable = new Gio.Cancellable();
        this._devices = new Set();
        this._menus = {};

        this.keybindingManager = new Keybindings.Manager();

        // Service Actions
        this.service = Gio.DBusActionGroup.get(
            Gio.DBus.session,
            gsconnect.app_id,
            gsconnect.app_path
        );

        // Service Indicator
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'org.gnome.Shell.Extensions.GSConnect-symbolic';

        AggregateMenu._indicators.insert_child_at_index(this.indicators, 0);
        AggregateMenu._gsconnect = this;

        // Service Menu
        this._item = new PopupMenu.PopupSubMenuMenuItem(_('Mobile Devices'), true);
        this._item.icon.icon_name = 'org.gnome.Shell.Extensions.GSConnect-symbolic';
        this._item.label.clutter_text.x_expand = true;
        this.menu.addMenuItem(this._item);

        AggregateMenu.menu.addMenuItem(this.menu, 4);

        // Service Menu -> Devices Section
        this.deviceSection = new PopupMenu.PopupMenuSection();
        this.deviceSection.actor.add_style_class_name('gsconnect-device-section');
        gsconnect.settings.bind(
            'show-indicators',
            this.deviceSection.actor,
            'visible',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this._item.menu.addMenuItem(this.deviceSection);

        // Service Menu -> Separator
        this._item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Service Menu -> "Do Not Disturb"
        this._item.menu.addMenuItem(new DoNotDisturb.MenuItem());

        // Service Menu -> "Mobile Settings"
        this._item.menu.addAction(
            _('Mobile Settings'),
            () => this.service.activate_action('preferences', null)
        );

        // Watch for UI prefs
        this._gsettingsId = gsconnect.settings.connect(
            'changed::show-indicators',
            this._sync.bind(this)
        );

        // Async setup
        this._init_async();
    }

    get available() {
        return Array.from(this.devices).filter(device => {
            return (device.Connected && device.Paired);
        });
    }

    get devices() {
        return this._devices;
    }

    async _init_async() {
        try {
            // Init the ObjectManager
            this.manager = await new Promise((resolve, reject) => {
                Gio.DBusObjectManagerClient.new_for_bus(
                    Gio.BusType.SESSION,
                    Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
                    gsconnect.app_id,
                    gsconnect.app_path,
                    null,
                    this._cancellable,
                    (manager, res) => {
                        try {
                            resolve(Gio.DBusObjectManagerClient.new_for_bus_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Setup currently managed devices
            for (let object of this.manager.get_objects()) {
                for (let iface of object.get_interfaces()) {
                    this._onInterfaceAdded(this.manager, object, iface);
                }
            }

            // Watch for new and removed
            this._nameOwnerId = this.manager.connect(
                'notify::name-owner',
                this._onNameOwnerChanged.bind(this)
            );

            this._interfaceAddedId = this.manager.connect(
                'interface-added',
                this._onInterfaceAdded.bind(this)
            );

            this._objectRemovedId = this.manager.connect(
                'object-removed',
                this._onObjectRemoved.bind(this)
            );

            this._interfaceProxyPropertiesChangedId = this.manager.connect(
                'interface-proxy-properties-changed',
                this._onInterfacePropertiesChanged.bind(this)
            );

            await this._activate();
        } catch (e) {
            debug(e);
            Gio.DBusError.strip_remote_error(e);

            // Don't notify of cancellation errors during startup
            // https://gitlab.gnome.org/GNOME/gnome-shell/issues/177
            if (!e.code || e.code !== Gio.IOErrorEnum.CANCELLED) {
                Main.notifyError(_('GSConnect'), e.message);
            }
        }
    }

    _onInterfacePropertiesChanged(manager, object, iface, changed, invalidated) {
        if (iface.g_interface_name !== 'org.gnome.Shell.Extensions.GSConnect.Device') {
            return;
        }

        changed = changed.deep_unpack();

        if (changed.hasOwnProperty('Connected') || changed.hasOwnProperty('Paired')) {
            this._sync();
        }
    }

    _sync() {
        // Hide status indicator if in Panel mode or no devices are available
        let panelMode = gsconnect.settings.get_boolean('show-indicators');
        this._indicator.visible = (!panelMode && this.available.length);

        // Show device indicators in Panel mode if available
        for (let device of this._devices.values()) {
            let indicator = Main.panel.statusArea[device.g_object_path].actor;
            indicator.visible = panelMode && this.available.includes(device);

            let menu = this._menus[device.g_object_path];
            menu.actor.visible = !panelMode && this.available.includes(device);
            menu._title.actor.visible = menu.actor.visible;
        }

        // One connected device in User Menu mode
        if (!panelMode && this.available.length === 1) {
            let device = this.available[0];

            // Hide the menu title and move it to the submenu item
            this._menus[device.g_object_path]._title.actor.visible = false;
            this._item.label.text = device.Name;

            // Destroy any other device's battery
            if (this._item._battery && this._item._battery.device !== device) {
                this._item._battery.destroy();
                this._item._battery = null;
            }

            // Add the battery to the submenu item
            if (!this._item._battery) {
                this._item._battery = new Device.Battery({
                    object: this.manager.get_object(device.g_object_path),
                    device: device,
                    opacity: 128
                });
                this._item.actor.insert_child_below(
                    this._item._battery,
                    this._item._triangleBin
                );
            }
        } else {
            if (this.available.length > 1) {
                //TRANSLATORS: %d is the number of devices connected
                this._item.label.text = gsconnect.ngettext('%d Connected', '%d Connected', this.available.length).format(this.available.length);
            } else {
                this._item.label.text = _('Mobile Devices');
            }

            // Destroy any battery in the submenu item
            if (this._item._battery) {
                this._item._battery.destroy();
                this._item._battery = null;
            }
        }
    }

    _activate() {
        if (this._activating) {
            return Promise.resolve(true);
        }

        this._activating = true;

        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'StartServiceByName',
                new GLib.Variant('(su)', [gsconnect.app_id, 0]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable,
                (connection, res) => {
                    try {
                        this._activating = false;
                        resolve(connection.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _onNameOwnerChanged(manager) {
        try {
            if (manager.name_owner === null) {
                this._indicator.visible = false;
                await this._activate();
            } else {
                this._indicator.visible = true;
            }
        } catch (e) {
            debug(e);
            Gio.DBusError.strip_remote_error(e);
            Main.notifyError(_('GSConnect'), e.message);
        }
    }

    _onInterfaceAdded(manager, object, iface) {
        gsconnect.proxyProperties(iface);

        // We only handle devices here
        if (iface.g_interface_name !== 'org.gnome.Shell.Extensions.GSConnect.Device') {
            return;
        }

        debug(`GSConnect: Adding ${iface.Name}`);
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

        // Device Indicator
        let indicator = new Device.Indicator({
            object: object,
            device: iface
        });
        Main.panel.addToStatusArea(iface.g_object_path, indicator);

        // Device Menu
        let menu = new Device.Menu({
            object: object,
            device: iface,
            menu_type: 'list'
        });
        this._menus[iface.g_object_path] = menu;
        this.deviceSection.addMenuItem(menu);

        // Keyboard Shortcuts
        iface._keybindingsChangedId = iface.settings.connect(
            'changed::keybindings',
            this._onKeybindingsChanged.bind(this, iface)
        );
        this._onKeybindingsChanged(iface);

        // Try activating the device
        iface.action_group.activate_action('activate', null);

        this._sync();
    }

    _onObjectRemoved(manager, object) {
        let iface = object.get_interface('org.gnome.Shell.Extensions.GSConnect.Device');

        debug(`GSConnect: Removing ${iface.Name}`);

        // Release keybindings
        iface.settings.disconnect(iface._keybindingsChangedId);
        iface._keybindings.map(id => this.keybindingManager.remove(id));

        // Destroy the indicator
        Main.panel.statusArea[iface.g_object_path].destroy();

        // Destroy the menu
        this._menus[iface.g_object_path].destroy();
        delete this._menus[iface.g_object_path];

        this.devices.delete(iface);
        this._sync();
    }

    async _onKeybindingsChanged(iface) {
        try {
            // Reset any existing keybindings
            if (iface.hasOwnProperty('_keybindings')) {
                iface._keybindings.map(id => this.keybindingManager.remove(id));
            }

            iface._keybindings = [];

            // Get the keybindings
            let keybindings = iface.settings.get_value('keybindings').deep_unpack();

            // TODO: Backwards compatible check for keybindings <= v12
            if (typeof keybindings === 'string') {
                iface.settings.set_value(
                    'keybindings',
                    new GLib.Variant('a{ss}', {})
                );
                return;
            }

            // Apply the keybindings
            for (let [action, accelerator] of Object.entries(keybindings)) {
                let [, name, parameter] = Gio.Action.parse_detailed_name(action);

                let actionId = this.keybindingManager.add(
                    accelerator,
                    () => iface.action_group.activate_action(name, parameter)
                );

                if (actionId !== 0) {
                    iface._keybindings.push(actionId);
                }
            }
        } catch (e) {
            logError(e);
        }
    }

    // TODO: need hardcoded keybinding for this
    _openDeviceMenu(indicator) {
        if (gsconnect.settings.get_boolean('show-indicators')) {
            indicator.menu.toggle();
        } else {
            Main.panel._toggleMenu(AggregateMenu);
            this._item.menu.toggle();
            this._item.actor.grab_key_focus();
        }
    }

    destroy() {
        this._cancellable.cancel();

        // Unhook from any ObjectManager events
        if (this.manager) {
            this.manager.disconnect(this._interfaceProxyPropertiesChangedId);
            this.manager.disconnect(this._interfaceAddedId);
            this.manager.disconnect(this._objectRemovedId);
            this.manager.disconnect(this._nameOwnerId);

            // Destroy any remaining devices
            for (let object of this.manager.get_objects()) {
                this._onObjectRemoved(this.manager, object);
            }
        }

        // Disconnect any keybindings
        this.keybindingManager.destroy();

        // Disconnect from any GSettings changes
        gsconnect.settings.disconnect(this._gsettingsId);

        // Destroy the UI
        delete AggregateMenu._gsconnect;
        this.indicators.destroy();
        this._item.destroy();
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
    debug('Enabling GSConnect');

    serviceIndicator = new ServiceIndicator();
    Notification.patchGtkNotificationSources();
}


function disable() {
    debug('Disabling GSConnect');

    serviceIndicator.destroy();
    serviceIndicator = null;
    Notification.unpatchGtkNotificationSources();
}
