'use strict';

const Cairo = imports.cairo;

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;

const ModalDialog = imports.ui.modalDialog;

// Local Imports
imports.searchPath.unshift(gsconnect.datadir);
const _ = gsconnect._;
const Color = imports.modules.color;
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
        if (!this.visible) { return; }

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
            this.tooltip.markup = _('Pair <b>%s</b>').format(this.device.Name) + '\n\n' + _('<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s').format(this.device.Name, this.device.Fingerprint, this.device.service.Fingerprint);
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

        this.connect('clicked', (button) => {
            if (!button.device.Connected) {
                button.device.Activate();
            } else if (!button.device.Paired) {
                button.device.Pair();
            } else {
                button.get_parent()._delegate._getTopMenu().close(true);
                button.device.OpenSettings();
            }
        });
    }
});
