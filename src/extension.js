'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Config = imports.misc.config;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const AggregateMenu = Main.panel.statusArea.aggregateMenu;

// Bootstrap
window.gsconnect = {
    extdatadir: imports.misc.extensionUtils.getCurrentExtension().path,
    shell_version: parseInt(Config.PACKAGE_VERSION.split('.')[1], 10)
};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const _ = gsconnect._;
const Device = imports.shell.device;
const DoNotDisturb = imports.shell.donotdisturb;
const Keybindings = imports.shell.keybindings;
const Notification = imports.shell.notification;
const Remote = imports.shell.remote;


/**
 * A function to fetch a GIcon with fallback support for getting unthemed icons
 * from our GResource in gnome-shell >= 3.32
 */
function get_gicon(name) {
    if (get_gicon.icons === undefined) {
        get_gicon.icons = {};
        get_gicon.theme = Gtk.IconTheme.get_default();
    }

    if (gsconnect.shell_version <= 30 || get_gicon.theme.has_icon(name))
        return new Gio.ThemedIcon({name: name});

    if (!get_gicon.icons[name]) {
        get_gicon.icons[name] = new Gio.FileIcon({
            file: Gio.File.new_for_uri(
                `resource://org/gnome/Shell/Extensions/GSConnect/icons/${name}.svg`
            )
        });
    }

    return get_gicon.icons[name];
}

gsconnect.get_gicon = get_gicon;


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
class ServiceIndicator extends PanelMenu.SystemIndicator {

    constructor() {
        super();

        this._menus = {};

        this.keybindingManager = new Keybindings.Manager();

        // Service Indicator
        this._indicator = this._addIndicator();
        this._indicator.gicon = gsconnect.get_gicon(
            'org.gnome.Shell.Extensions.GSConnect-symbolic'
        );
        this._indicator.visible = false;

        AggregateMenu._indicators.insert_child_at_index(this.indicators, 0);
        AggregateMenu._gsconnect = this;

        // Service Menu
        this._item = new PopupMenu.PopupSubMenuMenuItem(_('Mobile Devices'), true);
        this._item.icon.gicon = this._indicator.gicon;
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
        this._item.menu.addAction(_('Mobile Settings'), this._settings);

        // Watch for UI prefs
        this._gsettingsId = gsconnect.settings.connect(
            'changed::show-indicators',
            this._sync.bind(this)
        );

        // Async setup
        this._init_async();
    }

    async _init_async() {
        try {
            // Device Manager
            this.manager = new Remote.Service();

            // Watch for new and removed
            this._deviceAddedId = this.manager.connect(
                'device-added',
                this._onDeviceAdded.bind(this)
            );

            this._deviceRemovedId = this.manager.connect(
                'device-removed',
                this._onDeviceRemoved.bind(this)
            );

            this._availableChangedId = this.manager.connect(
                'available-changed',
                this._sync.bind(this)
            );

            await this.manager._init_async();
        } catch (e) {
            Gio.DBusError.strip_remote_error(e);

            if (!e.code || e.code !== Gio.IOErrorEnum.CANCELLED) {
                logError(e, 'GSConnect');
            }
        }
    }

    _sync() {
        let available = this.manager.available;
        let panelMode = gsconnect.settings.get_boolean('show-indicators');

        // Hide status indicator if in Panel mode or no devices are available
        this._indicator.visible = (!panelMode && available.length);

        // Show device indicators in Panel mode if available
        for (let device of this.manager.devices) {
            let indicator = Main.panel.statusArea[device.g_object_path].actor;
            indicator.visible = panelMode && available.includes(device);

            let menu = this._menus[device.g_object_path];
            menu.actor.visible = !panelMode && available.includes(device);
            menu._title.actor.visible = menu.actor.visible;
        }

        // One connected device in User Menu mode
        if (!panelMode && available.length === 1) {
            let device = available[0];

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
                    device: device,
                    opacity: 128
                });
                this._item.actor.insert_child_below(
                    this._item._battery,
                    this._item._triangleBin
                );
            }
        } else {
            if (available.length > 1) {
                // TRANSLATORS: %d is the number of devices connected
                this._item.label.text = gsconnect.ngettext(
                    '%d Connected',
                    '%d Connected',
                    available.length
                ).format(available.length);
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

    _settings() {
        Gio.DBus.session.call(
            'org.gnome.Shell.Extensions.GSConnect',
            '/org/gnome/Shell/Extensions/GSConnect',
            'org.freedesktop.Application',
            'ActivateAction',
            new GLib.Variant('(sava{sv})', ['settings', [], {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    logError(e, 'GSConnect');
                }
            }
        );
    }

    _onDeviceAdded(manager, device) {
        try {
            // Device Indicator
            let indicator = new Device.Indicator({device: device});
            Main.panel.addToStatusArea(device.g_object_path, indicator);

            // Device Menu
            let menu = new Device.Menu({
                device: device,
                menu_type: 'list'
            });
            this._menus[device.g_object_path] = menu;
            this.deviceSection.addMenuItem(menu);

            // Keyboard Shortcuts
            device._keybindingsChangedId = device.settings.connect(
                'changed::keybindings',
                this._onKeybindingsChanged.bind(this, device)
            );
            this._onKeybindingsChanged(device);

            // Try activating the device
            device.action_group.activate_action('activate', null);

            this._sync();
        } catch (e) {
            logError(e, device.g_object_path);
        }
    }

    _onDeviceRemoved(manager, device) {
        try {
            // Release keybindings
            device.settings.disconnect(device._keybindingsChangedId);
            device._keybindings.map(id => this.keybindingManager.remove(id));

            // Destroy the indicator
            Main.panel.statusArea[device.g_object_path].destroy();

            // Destroy the menu
            this._menus[device.g_object_path].destroy();
            delete this._menus[device.g_object_path];

            this._sync();
        } catch (e) {
            logError(e, device.g_object_path);
        }
    }

    async _onKeybindingsChanged(device) {
        try {
            // Reset any existing keybindings
            if (device.hasOwnProperty('_keybindings')) {
                device._keybindings.map(id => this.keybindingManager.remove(id));
            }

            device._keybindings = [];

            // Get the keybindings
            let keybindings = device.settings.get_value('keybindings').deep_unpack();

            // Apply the keybindings
            for (let [action, accelerator] of Object.entries(keybindings)) {
                let [, name, parameter] = Gio.Action.parse_detailed_name(action);

                let actionId = this.keybindingManager.add(
                    accelerator,
                    () => device.action_group.activate_action(name, parameter)
                );

                if (actionId !== 0) {
                    device._keybindings.push(actionId);
                }
            }
        } catch (e) {
            logError(e, device.g_object_path);
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
        // Unhook from any ObjectManager events
        if (this.manager) {
            this.manager.destroy();
            this.manager.disconnect(this._deviceAddedId);
            this.manager.disconnect(this._deviceRemovedId);
            this.manager.disconnect(this._availableChangedId);
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
    // This is only relevant on gnome-shell <= 3.30
    if (imports.system.version < 15500) {
        Gtk.IconTheme.get_default().add_resource_path('/org/gnome/Shell/Extensions/GSConnect/icons');
    }

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
    serviceIndicator = new ServiceIndicator();
    Notification.patchGtkNotificationSources();
}


function disable() {
    serviceIndicator.destroy();
    serviceIndicator = null;
    Notification.unpatchGtkNotificationSources();
}
