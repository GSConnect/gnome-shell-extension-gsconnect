'use strict';

const Cairo = imports.cairo;

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const _ = gsconnect._;
const Color = imports.modules.color;
const GMenu = imports.shell.gmenu;
const Tooltip = imports.shell.tooltip;



var BATTERY_INTERFACE = 'org.gnome.Shell.Extensions.GSConnect.Plugin.Battery';


/** St.BoxLayout subclass for a battery icon with text percentage */
var Battery = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceBattery'
}, class Battery extends St.BoxLayout {

    _init(object, device) {
        super._init({
            reactive: false,
            style_class: 'gsconnect-device-battery',
            visible: gsconnect.settings.get_boolean('show-battery')
        });

        this.object = object;
        this.device = device;

        this.label = new St.Label({ text: '' });
        this.add_child(this.label);

        this.icon = new St.Icon({ icon_size: 16 });
        this.add_child(this.icon);

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect(
                'g-properties-changed',
                this.update.bind(this)
            );
        }

        this.object.connect('interface-added', (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this._batteryId = this.battery.connect(
                    'g-properties-changed',
                    this.update.bind(this)
                );
            }
        });

        this.object.connect('interface-removed', (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this.battery.disconnect(this._batteryId);
                delete this._batteryId;
                delete this.battery;
            }
        });

        // Cleanup
        this.connect('destroy', (actor) => {
            if (actor._batteryId && actor.battery) {
                actor.battery.disconnect(actor._batteryId);
            }
        });
    }

    update(battery) {
        if (!this.mapped) { return; }

        this.icon.visible = (this.battery && this.battery.Level > -1);
        this.label.visible = (this.battery && this.battery.Level > -1);

        if (!this.icon.visible || !this.label.visible) { return; }

        this.icon.icon_name = this.battery.IconName;
        this.label.text = this.battery.Level + '%';
    }
});


/**
 * A Device Icon
 */
var Icon = GObject.registerClass({
    GtypeName: 'GSConnectShellDeviceIcon'
}, class Icon extends St.DrawingArea {

    _init(object, device) {
        super._init({
            width: 48,
            height: 48,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false
        });

        this.object = object;
        this.device = device;

        this.tooltip = new Tooltip.Tooltip({
            parent: this,
            markup: this.device.Name,
            y_offset: 16
        });

        // Device Type
        this._theme = Gtk.IconTheme.get_default();
        this.icon = this._theme.load_surface(
            this.device.IconName,
            32,
            1,
            null,
            Gtk.IconLookupFlags.FORCE_SIZE
        );

        this._themeSignal = this._theme.connect('changed', () => {
            this.icon = this._theme.load_surface(
                this.device.IconName,
                32,
                1,
                null,
                Gtk.IconLookupFlags.FORCE_SIZE
            );
            this.queue_repaint();
        });

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect(
                'g-properties-changed',
                () => this.queue_repaint()
            );
        }

        this.object.connect('interface-added', (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this._batteryId = this.battery.connect(
                    'g-properties-changed',
                    () => this.queue_repaint()
                );
            }
        });

        this.object.connect('interface-removed', (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this.battery.disconnect(this._batteryId);
                delete this._batteryId;
                delete this.battery;
            }
        });

        // Device Status
        this._propertiesId = device.connect(
            'g-properties-changed',
            () => this.queue_repaint()
        );

        this.connect('repaint', this._draw.bind(this));

        // Cleanup
        this.connect('destroy', (actor) => {
            actor.device.disconnect(actor._propertiesId);
            actor._theme.disconnect(actor._themeSignal);

            if (actor._batteryId && actor.battery) {
                actor.battery.disconnect(actor._batteryId);
            }
        });
    }

    get battery_color() {
        return Color.hsv2rgb(
            this.battery.Level / 100 * 120,
            100,
            100 - (this.battery.Level / 100 * 15)
        );
    }

    get battery_label() {
        let { Charging, Level, Time } = this.battery;

        if (Level === 100) {
            // TRANSLATORS: Fully Charged
            return _('Fully Charged');
        } else if (Time === 0) {
            // TRANSLATORS: <percentage> (Estimating…)
            return _('%d%% (Estimating…)').format(Level);
        }

        Time = Time / 60;
        let minutes = Time % 60;
        let hours = Math.floor(Time / 60);

        if (Charging) {
            // TRANSLATORS: <percentage> (<hours>:<minutes> Until Full)
            return _('%d%% (%d\u2236%02d Until Full)').format(
                Level,
                hours,
                minutes
            );
        } else {
            // TRANSLATORS: <percentage> (<hours>:<minutes> Remaining)
            return _('%d%% (%d\u2236%02d Remaining)').format(
                Level,
                hours,
                minutes
            );
        }
    }

    _draw() {
        if (!this.visible) { return; }

        let [width, height] = this.get_surface_size();
        let xc = width / 2;
        let yc = height / 2;

        let cr = this.get_context();
        let thickness = 3;
        let r = Math.min(xc, yc) - (thickness / 2);
        cr.setLineWidth(thickness);

        // Icon
        cr.setSourceSurface(this.icon, xc - 16, yc - 16);
        cr.paint();

        if (!this.device.Connected) {
            cr.setOperator(Cairo.Operator.HSL_SATURATION);
            cr.setSourceRGB(0, 0, 0);
            cr.maskSurface(this.icon, xc - 16, yc - 16);
            cr.fill();

            this.tooltip.markup = _('Reconnect <b>%s</b>').format(this.device.Name);
            this.tooltip.icon_name = 'view-refresh-symbolic';

            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setDash([3, 7], 0);
            cr.arc(xc, yc, r, 1.48 * Math.PI, 1.47 * Math.PI);
            cr.stroke();
        } else if (!this.device.Paired) {
            // TRANSLATORS: eg. Pair <b>Google Pixel</b>
            this.tooltip.markup = _('Pair <b>%s</b>').format(this.device.Name) +
                                 '\n\n' + this.device.EncryptionInfo;
            this.tooltip.icon_name = 'channel-insecure-symbolic';

            cr.setSourceRGB(0.95, 0.0, 0.0);
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setDash([3, 7], 0);
            cr.arc(xc, yc, r, 1.48 * Math.PI, 1.47 * Math.PI);
            cr.stroke();
        } else if (this.battery && this.battery.Level > -1) {
            // Depleted arc
            cr.setSourceRGB(0.8, 0.8, 0.8);

            if (this.battery.Level < 1) {
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
            } else if (this.battery.Level < 100) {
                let end = (this.battery.Level / 50 * Math.PI) + 1.5 * Math.PI;
                cr.arcNegative(xc, yc, r, 1.5 * Math.PI, end);
            }
            cr.stroke();

            // Remaining arc
            cr.setSourceRGB(...this.battery_color);

            if (this.battery.Level === 100) {
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
            } else if (this.battery.Level > 0) {
                let end = (this.battery.Level / 50 * Math.PI) + 1.5 * Math.PI;
                cr.arc(xc, yc, r, 1.5 * Math.PI, end);
            }
            this.tooltip.markup = this.battery_label;
            this.tooltip.icon_name = this.battery.IconName;
            cr.stroke();

            // Charging highlight
            if (this.battery.Charging) {
                cr.setOperator(Cairo.Operator.DEST_OVER);
                cr.setSourceRGBA(...this.battery_color, 0.25);
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
                cr.fill();
            }
        } else {
            this.tooltip.markup = _('Configure <b>%s</b>').format(this.device.Name);
            this.tooltip.icon_name = 'preferences-other-symbolic';
            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.arc(xc, yc, r, 0, 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
        return false;
    }
});


/** An St.Button subclass for buttons with an image and an action */
var Button = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceButton'
}, class Button extends St.Button {

    _init(object, device) {
        super._init({
            style_class: 'system-menu-action gsconnect-device-button',
            child: new Icon(object, device),
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_align: St.Align.START,
            y_fill: false,
            y_expand: false
        });
        this.set_y_align(Clutter.ActorAlign.START);

        this.object = object;
        this.device = device;

        this.connect('clicked', this._onClicked.bind(this));
    }

    _onClicked(button) {
        if (!button.device.Connected) {
            button.device.gactions.activate_action('activate', null);
        } else if (!button.device.Paired) {
            button.device.gactions.activate_action('pair', null);
        } else {
            button.get_parent()._delegate._getTopMenu().close(true);
            button.device.gactions.activate_action('openSettings', null);
        }
    }
});


/**
 * A PopupMenu used as an information and control center for a device
 */
var Menu = class Menu extends PopupMenu.PopupMenuSection {

    _init(object, iface) {
        super._init();

        this.object = object;
        this.device = iface;
        this._keybindings = [];

        // Device Box
        this.deviceBox = new PopupMenu.PopupBaseMenuItem({
            can_focus: false,
            reactive: false,
            style_class: 'popup-menu-item gsconnect-device-box'
        });
        this.deviceBox.actor.remove_child(this.deviceBox._ornamentLabel);
        this.deviceBox.actor.vertical = false;
        this.addMenuItem(this.deviceBox);

        this.deviceButton = new Button(object, iface);
        this.deviceBox.actor.add_child(this.deviceButton);

        this.controlBox = new St.BoxLayout({
            style_class: 'gsconnect-control-box',
            vertical: true,
            x_expand: true
        });
        this.deviceBox.actor.add_child(this.controlBox);

        // Title Bar
        this.titleBar = new St.BoxLayout({
            style_class: 'gsconnect-title-bar'
        });
        this.controlBox.add_child(this.titleBar);

        // Title Bar -> Device Name
        this.nameLabel = new St.Label({
            style_class: 'gsconnect-device-name',
            text: this.device.Name
        });
        this.titleBar.add_child(this.nameLabel);

        // Title Bar -> Separator
        let nameSeparator = new St.Widget({
            style_class: 'popup-separator-menu-item gsconnect-title-separator',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.titleBar.add_child(nameSeparator);

        // Title Bar -> Device Battery
        this.deviceBattery = new Battery(object, iface);
        this.titleBar.add_child(this.deviceBattery);

        // Plugin Bar
        this.pluginBar = new GMenu.FlowBox(iface.gmenu, iface.gactions);
        this.pluginBar.connect('submenu-toggle', this._onSubmenuToggle.bind(this));
        this.controlBox.add_child(this.pluginBar);

        // Status Bar
        this.statusBar = new St.BoxLayout({
            style_class: 'gsconnect-status-bar',
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true
        });
        this.controlBox.add_child(this.statusBar);

        this.statusLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.add_child(this.statusLabel);

        // Hide the submenu when the device menu is closed
        this._getTopMenu().connect('open-state-changed', (actor, open) => {
            if (!open && this._submenu) {
                this.box.remove_child(this._submenu.actor);
                this._submenu = undefined;
            }
        });

        // Watch GSettings & Properties
        this._gsettingsId = gsconnect.settings.connect('changed', this._sync.bind(this));
        this._propertiesId = this.device.connect('g-properties-changed', this._sync.bind(this));
        this.actor.connect('notify::mapped', this._sync.bind(this));

        // Init
        this._sync();
    }

    _onSubmenuToggle(box, button) {
        if (this._submenu) {
            this.box.remove_child(this._submenu.actor);
        }

        if (this._submenu !== button.submenu) {
            this._submenu = button.submenu;
            this.box.add_child(this._submenu.actor);
        } else {
            this._submenu = undefined;
        }
    }

    _sync() {
        debug(`${this.device.Name} (${this.device.Id})`);

        if (!this.actor.mapped) { return; }

        let { Connected, Paired } = this.device;

        // Title Bar
        this.nameLabel.text = this.device.Name;

        // TODO: might as well move this to actors.js
        if (Connected && Paired && gsconnect.settings.get_boolean('show-battery')) {
            this.deviceBattery.visible = true;
            this.deviceBattery.update();
        } else {
            this.deviceBattery.visible = false;
        }

        // Plugin/Status Bar visibility
        this.pluginBar.visible = (Connected && Paired);
        this.statusBar.visible = (!Connected || !Paired);

        if (!Connected) {
            this.statusLabel.text = _('Device is disconnected');
        } else if (!Paired) {
            this.statusLabel.text = _('Device is unpaired');
        }
    }

    destroy() {
        this.device.disconnect(this._propertiesId);
        gsconnect.settings.disconnect(this._gsettingsId);

        PopupMenu.PopupMenuSection.prototype.destroy.call(this);
    }
}


/** An indicator representing a Device in the Status Area */
var Indicator = class Indicator extends PanelMenu.Button {

    _init(object, iface) {
        super._init(null, `${iface.Name} Indicator`, false);

        this.object = object;
        this.device = iface;

        // Device Icon
        this.icon = new St.Icon({
            icon_name: this.device.SymbolicIconName,
            style_class: 'system-status-icon'
        });
        this.actor.add_actor(this.icon);

        // Menu
        this.deviceMenu = new Menu(object, iface);
        this.menu.addMenuItem(this.deviceMenu);

        // Watch GSettings & Properties
        this._gsettingsId = gsconnect.settings.connect('changed', this._sync.bind(this));
        this._propertiesId = this.device.connect('g-properties-changed', this._sync.bind(this));

        this._sync();
    }

    _sync() {
        debug(`${this.device.Name} (${this.device.Id})`);

        let { Connected, Paired } = this.device;

        // Device Indicator Visibility
        if (!gsconnect.settings.get_boolean('show-indicators')) {
            this.actor.visible = false;
        } else if (!Paired && !gsconnect.settings.get_boolean('show-unpaired')) {
            this.actor.visible = false;
        } else if (!Connected && !gsconnect.settings.get_boolean('show-offline')) {
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

