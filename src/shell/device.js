'use strict';

const Cairo = imports.cairo;

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
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

    _init(object, device) {
        super._init({
            reactive: false,
            style_class: 'gsconnect-device-battery',
            visible: gsconnect.settings.get_boolean('show-battery')
        });

        this.object = object;
        this.device = device;

        gsconnect.settings.bind(
            'show-battery',
            this,
            'visible',
            Gio.SettingsBindFlags.GET
        );

        this.label = new St.Label({ text: '' });
        this.add_child(this.label);

        this.icon = new St.Icon();
        this.add_child(this.icon);

        this._deviceId = this.device.connect(
            'g-properties-changed',
            this.update.bind(this)
        );

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect(
                'g-properties-changed',
                this.update.bind(this)
            );
        }

        this._interfaceAddedId = this.object.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );

        this._interfaceRemovedId = this.object.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );

        this.connect('notify::mapped', this.update.bind(this));

        // Cleanup
        this.connect('destroy', this._onDestroy);
    }

    _onDestroy(actor) {
        actor.device.disconnect(actor._deviceId);

        if (actor._batteryId && actor.battery) {
            actor.battery.disconnect(actor._batteryId);
        }

        actor.object.disconnect(actor._interfaceAddedId);
        actor.object.disconnect(actor._interfaceRemovedId);
    }

    _onInterfaceAdded(object, iface) {
        if (iface.g_interface_name === BATTERY_INTERFACE) {
            this.battery = iface;
            this._batteryId = this.battery.connect(
                'g-properties-changed',
                this.update.bind(this)
            );
        }
    }

    _onInterfaceRemoved(object, iface) {
        if (iface.g_interface_name === BATTERY_INTERFACE) {
            iface.disconnect(this._batteryId);
            this.battery = null;
            this._batteryId = 0;
        }
    }

    update(battery) {
        if (!this.mapped) { return; }

        let connected = (this.device.Connected && this.device.Paired);
        let visible = (connected && this.battery && this.battery.Level > -1);
        this.icon.visible = visible;
        this.label.visible = visible;

        if (!visible) { return; }

        this.icon.icon_name = this.battery.IconName;
        this.label.text = this.battery.Level + '%';
    }
});


/**
 * A Device Icon
 */
var Icon = GObject.registerClass({
    GTypeName: 'GSConnectShellDeviceIcon'
}, class Icon extends St.DrawingArea {

    _init(object, device) {
        super._init({
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false
        });

        this.object = object;
        this.device = device;

        // Watch for scale changes
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeContextId = this._themeContext.connect(
            'notify::scale-factor',
            this._onThemeChanged.bind(this)
        );

        // Watch for icon theme changes
        this._iconTheme = Gtk.IconTheme.get_default();
        this._iconThemeId = this._iconTheme.connect(
            'changed',
            this._onThemeChanged.bind(this)
        );

        this.tooltip = new Tooltip.Tooltip({
            parent: this,
            markup: this.device.Name,
            y_offset: 16 * this._themeContext.scale_factor
        });

        // Device Status
        this._propertiesId = device.connect(
            'g-properties-changed',
            () => this.queue_repaint()
        );

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect(
                'g-properties-changed',
                () => this.queue_repaint()
            );
        }

        // Watch for interface changes
        this._interfaceAddedId = this.object.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );

        this._interfaceRemovedId = this.object.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );

        // Redraw when mapped
        this._mappedId = this.connect(
            'notify::mapped',
            () => this.queue_repaint()
        );

        // Cleanup
        this.connect('destroy', this._onDestroy);
    }

    _onDestroy(actor) {
        actor.disconnect(actor._mappedId);

        actor.device.disconnect(actor._propertiesId);
        actor._iconTheme.disconnect(actor._iconThemeId);
        actor._themeContext.disconnect(actor._themeContextId);

        if (actor._batteryId && actor.battery) {
            actor.battery.disconnect(actor._batteryId);
        }

        actor.object.disconnect(actor._interfaceAddedId);
        actor.object.disconnect(actor._interfaceRemovedId);
    }

    _onInterfaceAdded(object, iface) {
        if (iface.g_interface_name === BATTERY_INTERFACE) {
            this.battery = iface;
            this._batteryId = iface.connect(
                'g-properties-changed',
                () => this.queue_repaint()
            );
        }
    }

    _onInterfaceRemoved(object, iface) {
        if (iface.g_interface_name === BATTERY_INTERFACE) {
            iface.disconnect(this._batteryId);
            this.battery = null;
        }
    }

    _update() {
        let scale = this._themeContext.scale_factor;

        // Get the unscaled size as defined in CSS
        if (this._width === undefined) {
            [this._width, this._height] = this.get_size();
            this._width = this._width / scale;
            this._height = this._height / scale;
        }

        // Resize the actor if the scale has changed
        if (!this._scale || this._scale !== scale) {
            this._scale = scale;
            this.tooltip.y_offset = 16 * scale;
            this.width = this._width * scale;
            this.height = this._height * scale;
        }

        // Size icon 2/3 of total, scaled and rounded up to multiple of 8
        let size = Math.ceil((this._width / 1.5 * scale) / 8) * 8;
        this._offset = size / 2;

        this._icon = this._iconTheme.load_surface(
            this.device.IconName,
            size,
            scale,
            null,
            Gtk.IconLookupFlags.FORCE_SIZE
        );
    }

    _onThemeChanged() {
        // Only update after we've been added to the stage
        if (this.width) {
            this._update();
            this.queue_repaint();
        }
    }

    get battery_color() {
        let h = (this.battery.Level / 100 * 120) / 360;
        let s = 1;
        let v = (100 - (this.battery.Level / 100 * 15)) / 100;

        let i = Math.floor(h * 6);
        let f = h * 6 - i;
        let p = v * (1 - s);
        let q = v * (1 - f * s);
        let t = v * (1 - (1 - f) * s);

        let r, g, b;

        switch (i % 6) {
            case 0: r = v, g = t, b = p; break;
            case 1: r = q, g = v, b = p; break;
            case 2: r = p, g = v, b = t; break;
            case 3: r = p, g = q, b = v; break;
            case 4: r = t, g = p, b = v; break;
            case 5: r = v, g = p, b = q; break;
        }

        return [r, g, b];
    }

    get battery_label() {
        let { Charging, Level, Time } = this.battery;

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

    vfunc_repaint() {
        if (!this.mapped) { return; }

        if (this._icon === undefined) {
            this._update();
        }

        let cr = this.get_context();

        // Dimensions have already been scaled
        let [width, height] = this.get_size();
        let xc = width / 2;
        let yc = height / 2;

        // Colored circle width
        let thickness = Math.ceil(this.width / 16);
        let r = Math.min(xc, yc) - (thickness / 2);
        cr.setLineWidth(thickness);

        // Icon
        cr.setSourceSurface(this._icon, xc - this._offset, yc - this._offset);
        cr.paint();

        if (!this.device.Connected) {
            cr.setOperator(Cairo.Operator.HSL_SATURATION);
            cr.setSourceRGB(0, 0, 0);
            cr.maskSurface(this._icon, xc - this._offset, yc - this._offset);
            cr.fill();

            this.tooltip.markup = _('Reconnect');
            this.tooltip.icon_name = 'view-refresh-symbolic';

            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setDash([3, 7], 0);
            cr.arc(xc, yc, r, 1.48 * Math.PI, 1.47 * Math.PI);
            cr.stroke();
        } else if (!this.device.Paired) {
            this.tooltip.markup = _('Pair') + '\n\n' + this.device.EncryptionInfo;
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
            this.tooltip.markup = _('Settings');
            this.tooltip.icon_name = 'preferences-system-symbolic';
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

        this.connect('clicked', this._onClicked);
    }

    _onClicked(button) {
        if (!button.device.Connected) {
            button.device.action_group.activate_action('activate', null);
        } else if (!button.device.Paired) {
            button.device.action_group.activate_action('pair', null);
        } else {
            button.get_parent()._delegate._getTopMenu().close(true);
            button.device.action_group.activate_action('openSettings', null);
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
        this._submenu = undefined;

        // Device Box
        this.deviceBox = new PopupMenu.PopupBaseMenuItem({
            can_focus: false,
            reactive: false,
            style_class: 'popup-menu-item gsconnect-device'
        });
        this.deviceBox.actor.remove_child(this.deviceBox._ornamentLabel);
        this.deviceBox.actor.vertical = false;
        this.addMenuItem(this.deviceBox);

        // Device Icon with Battery Circle
        this.deviceButton = new Button(object, iface);
        this.deviceBox.actor.add_child(this.deviceButton);

        // Title Bar & Plugin/Status Bar
        this.controlBox = new St.BoxLayout({
            style_class: 'gsconnect-device-box',
            vertical: true,
            x_expand: true
        });
        this.deviceBox.actor.add_child(this.controlBox);

        // Title Bar
        this.titleBar = new St.BoxLayout({
            style_class: 'gsconnect-device-title'
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
            style_class: 'popup-separator-menu-item',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.titleBar.add_child(nameSeparator);

        // Title Bar -> Device Battery
        this.deviceBattery = new Battery(object, iface);
        this.titleBar.add_child(this.deviceBattery);

        // Plugin Bar
        this.pluginBar = new GMenu.FlowBox({
            action_group: iface.action_group,
            menu_model: iface.menu_model,
            style_class: 'gsconnect-device-actions'
        });
        this.controlBox.add_child(this.pluginBar);

        // Status Bar
        this.statusBar = new St.BoxLayout({
            style_class: 'gsconnect-device-status',
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true
        });
        this.controlBox.add_child(this.statusBar);

        this.statusLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.add_child(this.statusLabel);

        //
        this.pluginBar.connect(
            'notify::submenu',
            this._onSubmenuChanged.bind(this)
        );

        // Hide the submenu when the device menu is closed
        this._getTopMenu().connect(
            'open-state-changed',
            this._onOpenStateChanged.bind(this)
        );

        // Watch Properties
        this._propertiesId = this.device.connect(
            'g-properties-changed',
            this._sync.bind(this)
        );
        this._mappedId = this.actor.connect(
            'notify::mapped',
            this._sync.bind(this)
        );
    }

    _onOpenStateChanged(actor, open) {
        if (!open && this._submenu !== undefined) {
            this.pluginBar.submenu = undefined;
        }
    }

    _onSubmenuChanged(flowbox) {
        // Close (remove) any currently opened submenu
        if (this._submenu !== undefined) {
            this.box.remove_child(this._submenu);
        }

        this._submenu = flowbox.submenu;

        // Open (add) the submenu if it's a new menu...
        if (this._submenu !== undefined) {
            this.box.add_child(this._submenu);
        }
    }

    _sync(proxy, changed, invalidated) {
        if (!this.actor.mapped) { return; }

        debug(`${this.device.Name} menu`);

        // Title Bar
        this.nameLabel.text = this.device.Name;

        // Plugin/Status Bar visibility
        let { Connected, Paired } = this.device;
        this.pluginBar.visible = (Connected && Paired);
        this.statusBar.visible = !this.pluginBar.visible;

        if (!Connected) {
            this.statusLabel.text = _('Device is disconnected');
        } else if (!Paired) {
            this.statusLabel.text = _('Device is unpaired');
        }
    }

    destroy() {
        this.actor.disconnect(this._mappedId);
        this.device.disconnect(this._propertiesId);

        super.destroy();
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
            gicon: this.symbolic_icon,
            style_class: 'system-status-icon'
        });
        this.actor.add_actor(this.icon);

        // Menu
        this.deviceMenu = new Menu(object, iface);
        this.menu.addMenuItem(this.deviceMenu);

        // Watch GSettings & Properties
        this._gsettingsId = gsconnect.settings.connect(
            'changed',
            this._sync.bind(this)
        );
        this._propertiesId = this.device.connect(
            'g-properties-changed',
            this._sync.bind(this)
        );

        this._sync();
    }

    get symbolic_icon() {
        let icon_name = `${this.device.IconName}-symbolic`;

        if (!this.device.Paired) {
            let rgba = new Gdk.RGBA({ red: 0.95, green: 0, blue: 0, alpha: 0.9 });
            let info = Gtk.IconTheme.get_default().lookup_icon(icon_name, 16, 0);
            return info.load_symbolic(rgba, null, null, null)[0];
        }

        return new Gio.ThemedIcon({ name: icon_name });
    }

    async _sync() {
        debug(`${this.device.Name} indicator`);

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

        this.icon.gicon = this.symbolic_icon;
        this.icon.opacity = Connected ? 255 : 128;
    }

    destroy() {
        this.device.disconnect(this._propertiesId);
        gsconnect.settings.disconnect(this._gsettingsId);

        super.destroy();
    }
}

