'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
const QuickSettings = imports.ui.quickSettings;

// Bootstrap
const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Extension.imports.shell.utils;

// eslint-disable-next-line no-redeclare
const _ = Extension._;
const Clipboard = Extension.imports.shell.clipboard;
const Config = Extension.imports.config;
const Device = Extension.imports.shell.device;
const Keybindings = Extension.imports.shell.keybindings;
const Notification = Extension.imports.shell.notification;
const Remote = Extension.imports.utils.remote;

Extension.getIcon = Utils.getIcon;


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
const ServiceToggle = GObject.registerClass({
    GTypeName: 'GSConnectServiceIndicator',
}, class ServiceToggle extends QuickSettings.QuickMenuToggle {

    _init() {
        super._init({
            label: 'GSConnect',
            iconName: 'org.gnome.Shell.Extensions.GSConnect-symbolic',
            toggleMode: true,
        });

        // Set QuickMenuToggle header.
        this.menu.setHeader('org.gnome.Shell.Extensions.GSConnect-symbolic', 'GSConnect',
            _('Sync between your devices'));

        this._menus = {};

        this._keybindings = new Keybindings.Manager();

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                null
            ),
            path: '/org/gnome/shell/extensions/gsconnect/',
        });

        // Bind the toggle to enabled key
        this.settings.bind('enabled',
            this, 'checked',
            Gio.SettingsBindFlags.DEFAULT);

        this._enabledId = this.settings.connect(
            'changed::enabled',
            this._onEnabledChanged.bind(this)
        );

        this._panelModeId = this.settings.connect(
            'changed::show-indicators',
            this._sync.bind(this)
        );

        // Service Proxy
        this.service = new Remote.Service();

        this._deviceAddedId = this.service.connect(
            'device-added',
            this._onDeviceAdded.bind(this)
        );

        this._deviceRemovedId = this.service.connect(
            'device-removed',
            this._onDeviceRemoved.bind(this)
        );

        this._serviceChangedId = this.service.connect(
            'notify::active',
            this._onServiceChanged.bind(this)
        );

        // Service Menu -> Devices Section
        this.deviceSection = new PopupMenu.PopupMenuSection();
        this.deviceSection.actor.add_style_class_name('gsconnect-device-section');
        this.settings.bind(
            'show-indicators',
            this.deviceSection.actor,
            'visible',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.menu.addMenuItem(this.deviceSection);

        // Service Menu -> Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Service Menu -> "Mobile Settings"
        this.menu.addAction(_('Mobile Settings'), this._preferences);

        // Prime the service
        this._initService();
    }

    async _initService() {
        try {
            if (this.settings.get_boolean('enabled'))
                await this.service.start();
            else
                await this.service.reload();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _preferences() {
        Gio.Subprocess.new([`${Extension.path}/gsconnect-preferences`], 0);
    }

    _sync() {
        const available = this.service.devices.filter(device => {
            return (device.connected && device.paired);
        });
        const panelMode = this.settings.get_boolean('show-indicators');

        // Hide status indicator if in Panel mode or no devices are available
        serviceIndicator._indicator.visible = (!panelMode && available.length);

        // Show device indicators in Panel mode if available
        for (const device of this.service.devices) {
            const isAvailable = available.includes(device);
            const indicator = Main.panel.statusArea[device.g_object_path];

            indicator.visible = panelMode && isAvailable;

            const menu = this._menus[device.g_object_path];
            menu.actor.visible = !panelMode && isAvailable;
            menu._title.actor.visible = !panelMode && isAvailable;
        }
    }

    _onDeviceChanged(device, changed, invalidated) {
        try {
            const properties = changed.deepUnpack();

            if (properties.hasOwnProperty('Connected') ||
                properties.hasOwnProperty('Paired'))
                this._sync();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceAdded(service, device) {
        try {
            // Device Indicator
            const indicator = new Device.Indicator({device: device});
            Main.panel.addToStatusArea(device.g_object_path, indicator);

            // Device Menu
            const menu = new Device.Menu({
                device: device,
                menu_type: 'list',
            });
            this._menus[device.g_object_path] = menu;
            this.deviceSection.addMenuItem(menu);

            // Device Settings
            device.settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device',
                    true
                ),
                path: `/org/gnome/shell/extensions/gsconnect/device/${device.id}/`,
            });

            // Keyboard Shortcuts
            device.__keybindingsChangedId = device.settings.connect(
                'changed::keybindings',
                this._onDeviceKeybindingsChanged.bind(this, device)
            );
            this._onDeviceKeybindingsChanged(device);

            // Watch the for status changes
            device.__deviceChangedId = device.connect(
                'g-properties-changed',
                this._onDeviceChanged.bind(this)
            );

            this._sync();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceRemoved(service, device, sync = true) {
        try {
            // Stop watching for status changes
            if (device.__deviceChangedId)
                device.disconnect(device.__deviceChangedId);

            // Release keybindings
            if (device.__keybindingsChangedId) {
                device.settings.disconnect(device.__keybindingsChangedId);
                device._keybindings.map(id => this._keybindings.remove(id));
            }

            // Destroy the indicator
            Main.panel.statusArea[device.g_object_path].destroy();

            // Destroy the menu
            this._menus[device.g_object_path].destroy();
            delete this._menus[device.g_object_path];

            if (sync)
                this._sync();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceKeybindingsChanged(device) {
        try {
            // Reset any existing keybindings
            if (device.hasOwnProperty('_keybindings'))
                device._keybindings.map(id => this._keybindings.remove(id));

            device._keybindings = [];

            // Get the keybindings
            const keybindings = device.settings.get_value('keybindings').deepUnpack();

            // Apply the keybindings
            for (const [action, accelerator] of Object.entries(keybindings)) {
                const [, name, parameter] = Gio.Action.parse_detailed_name(action);

                const actionId = this._keybindings.add(
                    accelerator,
                    () => device.action_group.activate_action(name, parameter)
                );

                if (actionId !== 0)
                    device._keybindings.push(actionId);
            }
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    async _onEnabledChanged(settings, key) {
        try {
            if (this.settings.get_boolean('enabled'))
                await this.service.start();
            else
                await this.service.stop();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    async _onServiceChanged(service, pspec) {
        try {
            // If it's enabled, we should try to restart now
            if (this.settings.get_boolean('enabled'))
                await this.service.start();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    destroy() {
        // Unhook from Remote.Service
        if (this.service) {
            this.service.disconnect(this._serviceChangedId);
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);

            for (const device of this.service.devices)
                this._onDeviceRemoved(this.service, device, false);

            this.service.stop();
            this.service.destroy();
        }

        // Disconnect any keybindings
        this._keybindings.destroy();

        // Disconnect from any GSettings changes
        this.settings.disconnect(this._enabledId);
        this.settings.disconnect(this._panelModeId);
        this.settings.run_dispose();

        // Destroy the PanelMenu.SystemIndicator actors
        this.menu.destroy();

        super.destroy();
    }
});

const ServiceIndicator = GObject.registerClass(
class ServiceIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();

        // Create the icon for the indicator
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'org.gnome.Shell.Extensions.GSConnect-symbolic';
        // Hide the indicator by default
        this._indicator.visible = false;

        // Create the toggle menu and associate it with the indicator
        this.quickSettingsItems.push(new ServiceToggle());

        // Add the indicator to the panel and the toggle to the menu
        QuickSettingsMenu._indicators.insert_child_at_index(this, 0);
        QuickSettingsMenu._addItems(this.quickSettingsItems);
    }

    destroy() {
        // Set enabled state to false to kill the service on destroy
        this.quickSettingsItems.forEach(item => item.destroy());
        // Destroy the indicator
        this._indicator.destroy();
        super.destroy();
    }
});

var serviceIndicator = null;

function init() {
    // If installed as a user extension, this will install the Desktop entry,
    // DBus and systemd service files necessary for DBus activation and
    // GNotifications. Since there's no uninit()/uninstall() hook for extensions
    // and they're only used *by* GSConnect, they should be okay to leave.
    Utils.installService();

    // These modify the notification source for GSConnect's GNotifications and
    // need to be active even when the extension is disabled (eg. lock screen).
    // Since they *only* affect notifications from GSConnect, it should be okay
    // to leave them applied.
    Notification.patchGSConnectNotificationSource();
    Notification.patchGtkNotificationDaemon();

    // This watches for the service to start and exports a custom clipboard
    // portal for use on Wayland
    Clipboard.watchService();
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
