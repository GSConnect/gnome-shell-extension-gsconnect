"use strict";

const Cairo = imports.cairo;

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const Tweener = imports.ui.tweener;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const _ = gsconnect._;
const Color = imports.modules.color;


/**
 */
var Dialog = class Dialog extends ModalDialog.ModalDialog {

    _init(params) {
        super._init();

        let headerBar = new St.BoxLayout({
            style_class: "nm-dialog-header-hbox"
        });
        this.contentLayout.add(headerBar);

        this._icon = new St.Icon({
            style_class: "nm-dialog-header-icon",
            gicon: new Gio.ThemedIcon({ name: params.icon })
        });
        headerBar.add(this._icon);

        let titleBox = new St.BoxLayout({ vertical: true });
        headerBar.add(titleBox);

        this._title = new St.Label({
            style_class: "nm-dialog-header",
            text: params.title
        });
        titleBox.add(this._title);

        this._subtitle = new St.Label({
            style_class: "nm-dialog-subheader",
            text: params.subtitle
        });
        titleBox.add(this._subtitle);

        this.contentLayout.style_class = "nm-dialog-content";

        this.content = new St.BoxLayout({ vertical: true });
        this.contentLayout.add(this.content);
    }

    get icon () {
        return this._icon.gicon.name;
    }

    set icon (name) {
        this._icon.gicon.name = name;
    }

    get title () {
        return this._title.text;
    }

    set title (text) {
        this._title.text = text;
    }

    get subtitle () {
        return this._title.text;
    }

    set subtitle (text) {
        this._title.text = text;
    }
}


/**
 * An StTooltip for ClutterActors
 *
 * Adapted from: https://github.com/RaphaelRochet/applications-overview-tooltip
 * See also: https://github.com/GNOME/gtk/blob/master/gtk/gtktooltip.c
 */
var TOOLTIP_BROWSE_ID = 0;
var TOOLTIP_BROWSE_MODE = false;

var Tooltip = class Tooltip {

    constructor(params) {
        // Properties
        Object.defineProperties(this, {
            "custom": {
                get: () => { return this._custom || false; },
                set: (actor) => {
                    this._custom = actor;
                    this._markup = null;
                    this._text = null;
                    this._update();
                }
            },
            "markup": {
                get: () => { return this._markup || false; },
                set: (value) => {
                    this._markup = value;
                    this._text = null;
                    this._update();
                }
            },
            "text": {
                get: () => { return this._text || false; },
                set: (value) => {
                    this._markup = null;
                    this._text = value;
                    this._update();
                }
            },
            "icon_name": {
                get: () => { return this._gicon.name; },
                set: (icon_name) => {
                    if (!icon_name) {
                        this.gicon = null;
                    } else {
                        this.gicon = new Gio.ThemedIcon({
                            name: icon_name
                        });
                    }
                }
            },
            "gicon": {
                get: () => { return this._gicon || false; },
                set: (gicon) => {
                    this._gicon = gicon;
                    this._update();
                }
            },
            "x_offset": {
                get: () => {
                    return (this._x_offset === undefined) ? 0 : this._x_offset;
                },
                set: (offset) => {
                    this._x_offset = (Number.isInteger(offset)) ? offset : 0;
                }
            },
            "y_offset": {
                get: () => {
                    return (this._y_offset === undefined) ? 0 : this._y_offset;
                },
                set: (offset) => {
                    this._y_offset = (Number.isInteger(offset)) ? offset : 0;
                }
            }
        });

        this._parent = params.parent;

        for (let param in params) {
            if (param !== "parent") {
                this[param] = params[param];
            }
        }

        this._hoverTimeoutId = 0;
        this._showing = false;

        // TODO: oddly fuzzy on menu items, sometimes
        if (this._parent.actor) { this._parent = this._parent.actor; }
        this._parent.connect("notify::hover", this._hover.bind(this));
        this._parent.connect("button-press-event", this._hide.bind(this));
        this._parent.connect("destroy", this.destroy.bind(this));
    }

    _update() {
        if (this._showing) {
            this._show();
        }
    }

    _show() {
        if (!this.text && !this.markup) {
            this._hide();
            return;
        }

        if (!this.bin) {
            this.bin = new St.Bin({
                style_class: "osd-window gsconnect-tooltip",
                opacity: 232
            });

            if (this.custom) {
                this.bin.child = this.custom;
            } else {
                this.bin.child = new St.BoxLayout({ vertical: false });

                if (this.gicon) {
                    this.bin.child.icon = new St.Icon({
                        gicon: this.gicon,
                        icon_size: 16,
                        y_align: St.Align.START
                    });
                    this.bin.child.icon.set_y_align(Clutter.ActorAlign.START);
                    this.bin.child.add_child(this.bin.child.icon);
                }

                this.label = new St.Label({
                    style_class: "gsconnect-tooltip-text",
                    text: this.markup || this.text
                });
                this.label.clutter_text.line_wrap = true;
                this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
                this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                this.label.clutter_text.use_markup = (this.markup);
                this.bin.child.add_child(this.label);
            }

            Main.layoutManager.uiGroup.add_actor(this.bin);
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bin, null);
        } else if (this.custom) {
            this.bin.child = this.custom;
        } else {
            if (this.bin.child.icon) { this.bin.child.icon.destroy(); }

            if (this.gicon) {
                this.bin.child.icon = new St.Icon({
                    gicon: this.gicon,
                    icon_size: 16,
                    style_class: "gsconnect-tooltip-icon"
                });
                this.bin.child.insert_child_at_index(this.bin.child.icon, 0);
            }

            this.label.clutter_text.text = this.markup || this.text;
            this.label.clutter_text.use_markup = (this.markup);
        }

        // Position tooltip
        let [x, y] = this._parent.get_transformed_position();
        x = (x + (this._parent.width/2)) - Math.round(this.bin.width/2);

        x += this.x_offset;
        y += this.y_offset;

        // Show tooltip
        if (this._showing) {
            Tweener.addTween(this.bin, {
                x: x,
                y: y,
                time: 0.15,
                transition: "easeOutQuad"
            });
        } else {
            this.bin.set_position(x, y);
            Tweener.addTween(this.bin, {
                opacity: 232,
                time: 0.15,
                transition: "easeOutQuad"
            });

            this._showing = true;
        }

        // Enable browse mode
        TOOLTIP_BROWSE_MODE = true;

        if (TOOLTIP_BROWSE_ID) {
            GLib.source_remove(TOOLTIP_BROWSE_ID);
            TOOLTIP_BROWSE_ID = 0;
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }

    _hide() {
        if (this.bin) {
            Tweener.addTween(this.bin, {
                opacity: 0,
                time: 0.10,
                transition: 'easeOutQuad',
                onComplete: () => {
                    Main.layoutManager.uiGroup.remove_actor(this.bin);

                    if (this.custom) {
                        this.bin.remove_child(this.custom);
                    }

                    this.bin.destroy();
                    delete this.bin;
                }
            });
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            TOOLTIP_BROWSE_MODE = false;
            TOOLTIP_BROWSE_ID = 0;
            return false;
        });

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }

        this._showing = false;
        this._hoverTimeoutId = 0;
    }

    _hover() {
        if (this._parent.hover) {
            if (!this._hoverTimeoutId) {
                if (this._showing) {
                    this._show();
                } else {
                    this._hoverTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        (TOOLTIP_BROWSE_MODE) ? 60 : 500,
                        () => {
                            this._show();
                            this._hoverTimeoutId = 0;
                            return false;
                        }
                    );
                }
            }
        } else {
            this._hide();
        }
    }

    destroy() {
        if (this.custom) {
            this.custom.destroy();
        }

        if (this.bin) {
            Main.layoutManager.uiGroup.remove_actor(this.bin);
            this.bin.destroy();
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }
}


var RadioButton = GObject.registerClass({
    GTypeName: "GSConnectShellRadioButton"
}, class RadioButton extends St.BoxLayout {

    _init(params) {
        params = Object.assign({
            text: null,
            widget: null,
            group: [],
            active: false,
            tooltip_markup: false,
            tooltip_text: false
        }, params);

        super._init({
            style_class: "radio-button",
            style: "spacing: 6px;",
            vertical: false
        });

        this.button = new St.Button({
            style_class: "pager-button",
            child: new St.Icon({ icon_name: "radio-symbolic", icon_size: 16 })
        });
        this.add_child(this.button);

        this.add_child(new St.Label());

        if (params.text) {
            this.text = params.text;
        } else {
            this.widget = params.widget;
        }

        //
        this.button.connect("clicked", () => {
            this.active = true;
        });

        // Group
        this.group = params.group;
        this.connect("destroy", () => {
            this.group.splice(this.group.indexOf(this), 1);
        });

        this.active = params.active;

        // Tooltip
        this.tooltip = new Tooltip({ parent: this });

        if (params.tooltip_markup) {
            this.tooltip.markup = params.tooltip_markup;
        } else if (params.tooltip_text) {
            this.tooltip.text = params.tooltip_text;
        }
    }

    get active() {
        return (this.button.child.icon_name === "radio-checked-symbolic");
    }

    set active(bool) {
        if (bool) {
            this.button.child.icon_name = "radio-checked-symbolic";

            for (let radio of this.group) {
                if (radio !== this) {
                    radio.button.child.icon_name = "radio-symbolic";
                }
            }
        } else {
            this.button.child.icon_name = "radio-symbolic";
        }
    }

    get group() {
        return this._group;
    }

    set group(group) {
        this._group = group;

        if (this._group.indexOf(this) < 0) {
            this._group.push(this);
        }

        this.active = (this.group.length === 1);
    }

    get text() {
        if (this.widget instanceof St.Label) {
            return this.widget.text;
        }

        return null;
    }

    set text(text) {
        if (typeof text === "string") {
            this.widget = new St.Label({ text: text });
        }
    }

    get widget () {
        return this.get_child_at_index(1);
    }

    set widget (widget) {
        if (widget instanceof Clutter.Actor) {
            widget.y_align = Clutter.ActorAlign.CENTER
            this.replace_child(this.widget, widget);
        }
    }
});


var MenuButton = GObject.registerClass({
    GTypeName: "GSConnectShellMenuButton"
}, class MenuButton extends St.Button {

    _init(params) {
        super._init({
            child: new St.Icon({ icon_name: params.item.icon }),
            style_class: "system-menu-action gsconnect-plugin-button",
            can_focus: true
        });

        this._gactions = params.gactions;
        this._item = params.item;
        this.connect("clicked", this._onClicked.bind(this));

        this.tooltip = new Tooltip({
            parent: this,
            markup: this._item.label
        });
    }

    _onClicked() {
        debug("activating: " + this._item.action);
        this._gactions.activate_action(this._item.action, null);
    }
});


var BATTERY_INTERFACE = "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery";


/** St.BoxLayout subclass for a battery icon with text percentage */
var DeviceBattery = GObject.registerClass({
    GTypeName: "GSConnectShellDeviceBattery"
}, class DeviceBattery extends St.BoxLayout {

    _init(object, device) {
        super._init({
            reactive: false,
            style_class: "gsconnect-device-battery",
            visible: gsconnect.settings.get_boolean("show-battery")
        });

        this.object = object;
        this.device = device;

        this.label = new St.Label({ text: "" });
        this.add_child(this.label);

        this.icon = new St.Icon({ icon_size: 16 });
        this.add_child(this.icon);

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect("g-properties-changed", this.update.bind(this));
        }

        this.object.connect("interface-added", (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this._batteryId = this.battery.connect("g-properties-changed", this.update.bind(this));
            }
        });

        this.object.connect("interface-removed", (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this.battery.disconnect(this._batteryId);
                delete this._batteryId;
                delete this.battery;
            }
        });

        // Cleanup
        this.connect("destroy", () => {
            if (this._batteryId && this.battery) {
                this.battery.disconnect(this._batteryId);
            }
        });
    }

    update(battery) {
        this.icon.visible = (this.battery && this.battery.Level > -1);
        this.label.visible = (this.battery && this.battery.Level > -1);

        this.icon.icon_name = this.battery.IconName;
        this.label.text = this.battery.Level + "%";
    }
});


/**
 * A Device Icon
 */
var DeviceIcon = GObject.registerClass({
    GtypeName: "GSConnectShellDeviceIcon"
}, class DeviceIcon extends St.DrawingArea {

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

        this.tooltip = new Tooltip({
            parent: this,
            markup: this.device.Name,
            y_offset: 16
        });

        // Device Type
        this._theme = Gtk.IconTheme.get_default();
        this.icon = this._theme.load_surface(this.device.IconName, 32, 1, null, 0);

        this._themeSignal = this._theme.connect("changed", () => {
            this.icon = this._theme.load_surface(this.device.IconName, 32, 1, null, 0);
            this.queue_repaint();
        });

        // Battery proxy
        this.battery = this.object.get_interface(BATTERY_INTERFACE);

        if (this.battery) {
            this._batteryId = this.battery.connect("g-properties-changed", () => this.queue_repaint());
        }

        this.object.connect("interface-added", (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this._batteryId = this.battery.connect("g-properties-changed", () => this.queue_repaint());
            }
        });

        this.object.connect("interface-removed", (obj, iface) => {
            if (iface.g_interface_name === BATTERY_INTERFACE) {
                this.battery = iface;
                this.battery.disconnect(this._batteryId);
                delete this._batteryId;
                delete this.battery;
            }
        });

        // Device Status
        device.connect("g-properties-changed", () => this.queue_repaint());

        this.connect("repaint", this._draw.bind(this));
        this.connect("destroy", () => {
            this._theme.disconnect(this._themeSignal);
            if (this._batteryId && this.battery) {
                this.battery.disconnect(this._batteryId);
            }
        });
    }

    _batteryColor() {
        return Color.hsv2rgb(
            this.battery.Level / 100 * 120,
            100,
            100 - (this.battery.Level / 100 * 15)
        );
    }

    _getTimeLabel() {
        let { Charging, Level, Time } = this.battery;

        if (Level === 100) {
            // TRANSLATORS: Fully Charged
            return _("Fully Charged");
        } else if (Time === 0) {
            // TRANSLATORS: <percentage> (Estimating…)
            return _("%d%% (Estimating…)").format(Level);
        }

        Time = Time / 60;
        let minutes = Time % 60;
        let hours = Math.floor(Time / 60);

        if (Charging) {
            // TRANSLATORS: <percentage> (<hours>:<minutes> Until Full)
            return _("%d%% (%d\u2236%02d Until Full)").format(
                Level,
                hours,
                minutes
            );
        } else {
            // TRANSLATORS: <percentage> (<hours>:<minutes> Remaining)
            return _("%d%% (%d\u2236%02d Remaining)").format(
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

            this.tooltip.markup = _("Reconnect <b>%s</b>").format(this.device.Name);
            this.tooltip.icon_name = "view-refresh-symbolic";

            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setDash([3, 7], 0);
            cr.arc(xc, yc, r, 1.48 * Math.PI, 1.47 * Math.PI);
            cr.stroke();
        } else if (!this.device.Paired) {
            this.tooltip.markup = _("Pair <b>%s</b>").format(this.device.Name) + "\n\n" + _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.Name, this.device.Fingerprint, this.device.service.Fingerprint);
            this.tooltip.icon_name = "channel-insecure-symbolic";

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
            cr.setSourceRGB(...this._batteryColor());

            if (this.battery.Level === 100) {
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
            } else if (this.battery.Level > 0) {
                let end = (this.battery.Level / 50 * Math.PI) + 1.5 * Math.PI;
                cr.arc(xc, yc, r, 1.5 * Math.PI, end);
            }
            this.tooltip.markup = this._getTimeLabel();
            this.tooltip.icon_name = this.battery.IconName;
            cr.stroke();

            // Charging highlight
            if (this.battery.Charging) {
                cr.setOperator(Cairo.Operator.DEST_OVER);
                cr.setSourceRGBA(...this._batteryColor(), 0.25);
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
                cr.fill();
            }
        } else {
            this.tooltip.markup = _("Configure <b>%s</b>").format(this.device.Name);
            this.tooltip.icon_name = "preferences-other-symbolic";
            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.arc(xc, yc, r, 0, 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
        return false;
    }
});


/** An St.Button subclass for buttons with an image and an action */
var DeviceButton = GObject.registerClass({
    GTypeName: "GSConnectShellDeviceButton"
}, class DeviceButton extends St.Button {

    _init(object, device) {
        super._init({
            style_class: "system-menu-action gsconnect-device-button",
            child: new DeviceIcon(object, device),
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

        this.connect("clicked", () => {
            if (!this.device.Connected) {
                this.device.Activate();
            } else if (!this.device.Paired) {
                this.device.pair();
            } else {
                this.get_parent()._delegate._getTopMenu().close(true);
                this.device.OpenSettings();
            }
        });
    }
});

