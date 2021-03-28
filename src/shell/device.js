'use strict';

const Clutter = imports.gi.Clutter;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Extension = imports.misc.extensionUtils.getCurrentExtension();

// eslint-disable-next-line no-redeclare
const _ = Extension._;
const GMenu = Extension.imports.shell.gmenu;
const Tooltip = Extension.imports.shell.tooltip;


/**
 * A battery widget with an icon, text percentage and time estimate tooltip
 */
var Battery = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceBattery',
}, class Battery extends St.BoxLayout {

    _init(params) {
        super._init({
            reactive: true,
            style_class: 'gsconnect-device-battery',
            track_hover: true,
        });
        Object.assign(this, params);

        // Percent Label
        this.label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label.clutter_text.ellipsize = 0;
        this.add_child(this.label);

        // Battery Icon
        this.icon = new St.Icon({
            fallback_icon_name: 'battery-missing-symbolic',
            icon_size: 16,
        });
        this.add_child(this.icon);

        // Battery Estimate
        this.tooltip = new Tooltip.Tooltip({
            parent: this,
            text: null,
        });

        // Battery GAction
        this._actionAddedId = this.device.action_group.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        this._actionRemovedId = this.device.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );
        this._actionStateChangedId = this.device.action_group.connect(
            'action-state-changed',
            this._onStateChanged.bind(this)
        );

        this._onActionChanged(this.device.action_group, 'battery');

        // Cleanup on destroy
        this.connect('destroy', this._onDestroy);
    }

    _onActionChanged(action_group, action_name) {
        if (action_name !== 'battery')
            return;

        if (action_group.has_action('battery')) {
            const value = action_group.get_action_state('battery');
            const [charging, icon_name, level, time] = value.deepUnpack();

            this._state = {
                charging: charging,
                icon_name: icon_name,
                level: level,
                time: time,
            };
        } else {
            this._state = null;
        }

        this._sync();
    }

    _onStateChanged(action_group, action_name, value) {
        if (action_name !== 'battery')
            return;

        const [charging, icon_name, level, time] = value.deepUnpack();

        this._state = {
            charging: charging,
            icon_name: icon_name,
            level: level,
            time: time,
        };

        this._sync();
    }

    _getBatteryLabel() {
        if (!this._state)
            return null;

        const {charging, level, time} = this._state;

        if (level === 100)
            // TRANSLATORS: When the battery level is 100%
            return _('Fully Charged');

        if (time === 0)
            // TRANSLATORS: When no time estimate for the battery is available
            // EXAMPLE: 42% (Estimating…)
            return _('%d%% (Estimating…)').format(level);

        const total = time / 60;
        const minutes = Math.floor(total % 60);
        const hours = Math.floor(total / 60);

        if (charging) {
            // TRANSLATORS: Estimated time until battery is charged
            // EXAMPLE: 42% (1:15 Until Full)
            return _('%d%% (%d\u2236%02d Until Full)').format(
                level,
                hours,
                minutes
            );
        } else {
            // TRANSLATORS: Estimated time until battery is empty
            // EXAMPLE: 42% (12:15 Remaining)
            return _('%d%% (%d\u2236%02d Remaining)').format(
                level,
                hours,
                minutes
            );
        }
    }

    _onDestroy(actor) {
        actor.device.action_group.disconnect(actor._actionAddedId);
        actor.device.action_group.disconnect(actor._actionRemovedId);
        actor.device.action_group.disconnect(actor._actionStateChangedId);
    }

    _sync() {
        this.visible = !!this._state;

        if (!this.visible)
            return;

        this.icon.icon_name = this._state.icon_name;
        this.label.text = (this._state.level > -1) ? `${this._state.level}%` : '';
        this.tooltip.text = this._getBatteryLabel();
    }
});


/**
 * A cell signal strength widget with two icons
 */
var SignalStrength = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceSignalStrength',
}, class SignalStrength extends St.BoxLayout {

    _init(params) {
        super._init({
            reactive: true,
            style_class: 'gsconnect-device-signal-strength',
            track_hover: true,
        });
        Object.assign(this, params);

        // Network Type Icon
        this.networkTypeIcon = new St.Icon({
            fallback_icon_name: 'network-cellular-symbolic',
            icon_size: 16,
        });
        this.add_child(this.networkTypeIcon);

        // Signal Strength Icon
        this.signalStrengthIcon = new St.Icon({
            fallback_icon_name: 'network-cellular-offline-symbolic',
            icon_size: 16,
        });
        this.add_child(this.signalStrengthIcon);

        // Network Type Text
        this.tooltip = new Tooltip.Tooltip({
            parent: this,
            text: null,
        });

        // ConnectivityReport GAction
        this._actionAddedId = this.device.action_group.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        this._actionRemovedId = this.device.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );
        this._actionStateChangedId = this.device.action_group.connect(
            'action-state-changed',
            this._onStateChanged.bind(this)
        );

        this._onActionChanged(this.device.action_group, 'connectivityReport');

        // Cleanup on destroy
        this.connect('destroy', this._onDestroy);
    }

    _onActionChanged(action_group, action_name) {
        if (action_name !== 'connectivityReport')
            return;

        if (action_group.has_action('connectivityReport')) {
            const value = action_group.get_action_state('connectivityReport');
            const [
                cellular_network_type,
                cellular_network_type_icon,
                cellular_network_strength,
                cellular_network_strength_icon,
                hotspot_name,
                hotspot_bssid,
            ] = value.deepUnpack();

            this._state = {
                cellular_network_type: cellular_network_type,
                cellular_network_type_icon: cellular_network_type_icon,
                cellular_network_strength: cellular_network_strength,
                cellular_network_strength_icon: cellular_network_strength_icon,
                hotspot_name: hotspot_name,
                hotspot_bssid: hotspot_bssid,
            };
        } else {
            this._state = null;
        }

        this._sync();
    }

    _onStateChanged(action_group, action_name, value) {
        if (action_name !== 'connectivityReport')
            return;

        const [
            cellular_network_type,
            cellular_network_type_icon,
            cellular_network_strength,
            cellular_network_strength_icon,
            hotspot_name,
            hotspot_bssid,
        ] = value.deepUnpack();

        this._state = {
            cellular_network_type: cellular_network_type,
            cellular_network_type_icon: cellular_network_type_icon,
            cellular_network_strength: cellular_network_strength,
            cellular_network_strength_icon: cellular_network_strength_icon,
            hotspot_name: hotspot_name,
            hotspot_bssid: hotspot_bssid,
        };

        this._sync();
    }

    _onDestroy(actor) {
        actor.device.action_group.disconnect(actor._actionAddedId);
        actor.device.action_group.disconnect(actor._actionRemovedId);
        actor.device.action_group.disconnect(actor._actionStateChangedId);
    }

    _sync() {
        this.visible = !!this._state;

        if (!this.visible)
            return;

        this.networkTypeIcon.icon_name = this._state.cellular_network_type_icon;
        this.signalStrengthIcon.icon_name = this._state.cellular_network_strength_icon;
        this.tooltip.text = this._state.cellular_network_type;
    }
});


/**
 * A PopupMenu used as an information and control center for a device
 */
var Menu = class Menu extends PopupMenu.PopupMenuSection {

    constructor(params) {
        super();
        Object.assign(this, params);

        this.actor.add_style_class_name('gsconnect-device-menu');

        // Title
        this._title = new PopupMenu.PopupSeparatorMenuItem(this.device.name);
        this.addMenuItem(this._title);

        // Title -> Name
        this._title.label.style_class = 'gsconnect-device-name';
        this._title.label.clutter_text.ellipsize = 0;
        this.device.bind_property(
            'name',
            this._title.label,
            'text',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Title -> Cellular Signal Strength
        this._signalStrength = new SignalStrength({device: this.device});
        this._title.actor.add_child(this._signalStrength);

        // Title -> Battery
        this._battery = new Battery({device: this.device});
        this._title.actor.add_child(this._battery);

        // Actions
        let actions;

        if (this.menu_type === 'icon') {
            actions = new GMenu.IconBox({
                action_group: this.device.action_group,
                model: this.device.menu,
            });
        } else if (this.menu_type === 'list') {
            actions = new GMenu.ListBox({
                action_group: this.device.action_group,
                model: this.device.menu,
            });
        }

        this.addMenuItem(actions);
    }

    isEmpty() {
        return false;
    }
};


/**
 * An indicator representing a Device in the Status Area
 */
var Indicator = GObject.registerClass({
    GTypeName: 'GSConnectDeviceIndicator',
}, class Indicator extends PanelMenu.Button {

    _init(params) {
        super._init(0.0, `${params.device.name} Indicator`, false);
        Object.assign(this, params);

        // Device Icon
        this._icon = new St.Icon({
            gicon: Extension.getIcon(this.device.icon_name),
            style_class: 'system-status-icon gsconnect-device-indicator',
        });
        this.add_child(this._icon);

        // Menu
        const menu = new Menu({
            device: this.device,
            menu_type: 'icon',
        });
        this.menu.addMenuItem(menu);
    }
});

