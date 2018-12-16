'use strict';

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const _ = gsconnect._;
const GMenu = imports.shell.gmenu;
const Tooltip = imports.shell.tooltip;



var BATTERY_INTERFACE = 'org.gnome.Shell.Extensions.GSConnect.Battery';


/** St.BoxLayout subclass for a battery icon with text percentage */
var Battery = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceBattery'
}, class Battery extends St.BoxLayout {

    _init(params) {
        super._init({
            reactive: true,
            style_class: 'gsconnect-device-battery',
            track_hover: true
        });
        Object.assign(this, params);

        // Percent Label
        this.label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER
        });
        this.label.clutter_text.ellipsize = 0;
        this.add_child(this.label);

        // Battery Icon
        this.icon = new St.Icon({
            fallback_icon_name: 'battery-missing-symbolic'
        });
        this.add_child(this.icon);

        // Battery Estimate
        this.tooltip = new Tooltip.Tooltip({
            parent: this,
            text: this.battery_label
        });

        // Battery Added/Removed
        this._interfaceAddedId = this.object.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );

        this._interfaceRemovedId = this.object.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );

        // Battery proxy
        let iface = this.object.get_interface(BATTERY_INTERFACE);
        if (iface) this._onInterfaceAdded(null, iface);

        // Refresh when mapped
        this._mappedId = this.connect('notify::mapped', this._sync.bind(this));
        this._sync();

        // Cleanup
        this.connect('destroy', this._onDestroy);
    }

    get battery_label() {
        if (!this.battery) return null;

        let {Charging, Level, Time} = this.battery;

        if (Level === 100) {
            // TRANSLATORS: When the battery level is 100%
            return _('Fully Charged');
        } else if (Time === 0) {
            // TRANSLATORS: When no time estimate for the battery is available
            // EXAMPLE: 42% (Estimating…)
            return _('%d%% (Estimating…)').format(Level);
        }

        Time = Time / 60;
        let minutes = Math.floor(Time % 60);
        let hours = Math.floor(Time / 60);

        if (Charging) {
            // TRANSLATORS: Estimated time until battery is charged
            // EXAMPLE: 42% (1:15 Until Full)
            return _('%d%% (%d\u2236%02d Until Full)').format(
                Level,
                hours,
                minutes
            );
        } else {
            // TRANSLATORS: Estimated time until battery is empty
            // EXAMPLE: 42% (12:15 Remaining)
            return _('%d%% (%d\u2236%02d Remaining)').format(
                Level,
                hours,
                minutes
            );
        }
    }

    _onDestroy(actor) {
        actor.object.disconnect(actor._interfaceAddedId);
        actor.object.disconnect(actor._interfaceRemovedId);
        actor.disconnect(actor._mappedId);

        if (actor._batteryId && actor.battery) {
            actor.battery.disconnect(actor._batteryId);
        }
    }

    _onInterfaceAdded(object, iface) {
        if (iface.g_interface_name !== BATTERY_INTERFACE) return;

        this.battery = iface;
        gsconnect.proxyProperties(iface);

        this._batteryId = this.battery.connect(
            'g-properties-changed',
            this._sync.bind(this)
        );

        this._sync();
    }

    _onInterfaceRemoved(object, iface) {
        if (iface.g_interface_name === BATTERY_INTERFACE) {
            this._batteryId = iface.disconnect(this._batteryId);
            this.battery = null;
        }
    }

    _sync() {
        this.visible = (this.battery);

        if (this.visible && this.mapped) {
            this.icon.icon_name = this.battery.IconName;
            this.label.text = (this.battery.Level > -1) ? `${this.battery.Level}%` : '';
            this.tooltip.text = this.battery_label;
        }
    }
});


/**
 * A PopupMenu used as an information and control center for a device
 */
var Menu = class Menu extends PopupMenu.PopupMenuSection {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.actor.add_style_class_name('gsconnect-device-menu');

        // Title
        this._title = new PopupMenu.PopupSeparatorMenuItem(this.device.Name);
        this.addMenuItem(this._title);

        // Title -> Name
        this._title.label.style_class = 'gsconnect-device-name';
        this._title.label.clutter_text.ellipsize = 0;
        this._nameId = this.device.settings.connect(
            'changed::name',
            this._onNameChanged.bind(this)
        );
        this.actor.connect('destroy', this._onDestroy);

        // Title -> Battery
        this._battery = new Battery({object: this.object});
        this._title.actor.add_child(this._battery);

        // Actions
        if (this.menu_type === 'icon') {
            this._actions = new GMenu.IconBox({
                action_group: this.device.action_group,
                menu_model: this.device.menu_model
            });
        } else if (this.menu_type === 'list') {
            this._actions = new GMenu.ListBox({
                action_group: this.device.action_group,
                menu_model: this.device.menu_model
            });
        }

        this.addMenuItem(this._actions);
    }

    _onDestroy(actor) {
        actor._delegate.device.settings.disconnect(actor._delegate._nameId);
    }

    _onNameChanged(settings) {
        this._title.label.text = settings.get_string('name');
    }

    isEmpty() {
        return false;
    }
};


/** An indicator representing a Device in the Status Area */
var Indicator = class Indicator extends PanelMenu.Button {

    _init(params) {
        super._init(null, `${params.device.Name} Indicator`, false);
        Object.assign(this, params);

        // Device Icon
        let icon = new St.Icon({
            gicon: new Gio.ThemedIcon({name: this.device.IconName}),
            style_class: 'system-status-icon gsconnect-device-indicator'
        });
        this.actor.add_child(icon);

        // Menu
        let menu = new Menu({
            object: this.object,
            device: this.device,
            menu_type: 'icon'
        });
        this.menu.addMenuItem(menu);
    }
};

