"use strict";

// Imports
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;

/** 
 * An StTooltip for ClutterActors
 * 
 * Adapted from: https://github.com/RaphaelRochet/applications-overview-tooltip
 * See also: https://github.com/GNOME/gtk/blob/master/gtk/gtktooltip.c
 */
var TOOLTIP_BROWSE_ID = 0;
var TOOLTIP_BROWSE_MODE = false;

var Tooltip = new Lang.Class({
    Name: "GSConnectShellTooltip",
    
    _init: function (params) {
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
                    this._markup = value;
                    this._text = null;
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
                    return (this._x_offset === undefined) ? 0 : this._x_offset;
                },
                set: (offset) => {
                    this._x_offset = (Number.isInteger(offset)) ? offset : 0;
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
        this._parent.connect("notify::hover", Lang.bind(this, this._hover));
        this._parent.connect("button-press-event", Lang.bind(this, this._hide));
        this._parent.connect("destroy", Lang.bind(this, this.destroy));
    },
    
    _update: function () {
        if (this._showing) {
            this._show();
        }
    },
    
    _show: function () {
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
                        icon_size: 16
                    });
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
            Mainloop.source_remove(TOOLTIP_BROWSE_ID);
            TOOLTIP_BROWSE_ID = 0;
        }
        
        if (this._hoverTimeoutId) {
            Mainloop.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    },
    
    _hide: function () {
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
                    this.bin = null;
                }
            });
        }
        
        TOOLTIP_BROWSE_ID = Mainloop.timeout_add(500, () => {
            TOOLTIP_BROWSE_MODE = false;
            TOOLTIP_BROWSE_ID = 0;
            return false;
        });
        
        if (this._hoverTimeoutId) {
            Mainloop.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
        
        this._showing = false;
        this._hoverTimeoutId = 0;
    },
    
    _hover: function () {
        if (this._parent.hover) {
            if (!this._hoverTimeoutId) {
                let timeout = (TOOLTIP_BROWSE_MODE) ? 60 : 500;
                
                if (this._showing) {
                    this._show();
                } else {
                    this._hoverTimeoutId = Mainloop.timeout_add(timeout, () => {
                        this._show();
                        this._hoverTimeoutId = 0;
                        return false;
                    });
                }
            }
        } else {
            this._hide();
        }
    },
    
    destroy: function () {
        this._hide();
        if (this.custom) {
            this.custom.destroy();
        }
    }
});


/** St.Button subclass for plugin buttons with an image, action and tooltip */
var PluginButton = new Lang.Class({
    Name: "GSConnectShellPluginButton",
    Extends: St.Button,
    
    _init: function (params) {
        params = Object.assign({
            icon_name: "application-x-executable",
            callback: () => {},
            toggle_mode: false,
            tooltip_markup: false,
            tooltip_text: false
        }, params);
    
        this.parent({
            style_class: "system-menu-action gsconnect-plugin-button",
            child: new St.Icon({ icon_name: params.icon_name }),
            toggle_mode: params.toggle_mode,
            can_focus: true
        });
        
        this.callback = params.callback;
        
        this.connect("clicked", () => {
            this.callback(this);
        });
        
        this.connect("notify::checked", () => {
            if (this.checked) {
                this.add_style_pseudo_class("active");
            } else {
                this.remove_style_pseudo_class("active");
            }
        });
        
        this.tooltip = new Tooltip({ parent: this });
        
        if (params.tooltip_markup) {
            this.tooltip.markup = params.tooltip_markup;
        } else if (params.tooltip_text) {
            this.tooltip.text = params.tooltip_text;
        }
    }
});


/** St.BoxLayout subclass for a battery icon with text percentage */
var DeviceBattery = new Lang.Class({
    Name: "GSConnectShellDeviceBattery",
    Extends: St.BoxLayout,
    
    _init: function (device) {
        this.parent({
            reactive: false,
            style_class: "gsconnect-device-battery"
        });
        
        this.device = device;
        
        this.label = new St.Label({ text: "" });
        this.add_child(this.label);
        
        this.icon = new St.Icon({
            icon_name: "battery-missing-symbolic",
            icon_size: 16
        });
        this.add_child(this.icon);
        
        if (this.device.battery) {
            this._battery = this.device.battery.connect("notify", () => {
                this.update();
            });
        }
        
        this.device.connect("notify::plugins", () => {
            if (this.device.battery && !this._battery) {
                this._battery = this.device.battery.connect("notify", () => {
                    this.update();
                });
                this.update();
            } else if (!this.device.battery && this._battery) {
                delete this._battery;
            }
        });
        
        this.update();
    },
    
    update: function () {
        if (!this.visible) { return; }
        
        // Fix for "JS ERROR: TypeError: this.device.battery is undefined"
        if (this.device.battery === undefined) {
            this.icon.icon_name = "battery-missing-symbolic";
            this.label.text = "";
            return;
        }
        
        let {charging, level} = this.device.battery;
        let icon = "battery";
        
        if (level < 3) {
            icon += "-empty";
        } else if (level < 10) {
            icon += "-caution";
        } else if (level < 30) {
            icon += "-low";
        } else if (level < 60) {
            icon += "-good";
        } else if (level >= 60) {
            icon += "-full";
        }
        
        icon = (charging) ? icon + "-charging" : icon;
        this.icon.icon_name = icon + "-symbolic";
        this.label.text = level + "%";
        
        // "false, -1" if no data or remote plugin is disabled but not local
        if (level === -1) {
            this.icon.icon_name = "battery-missing-symbolic";
            this.label.text = "";
        }
    }
});


/**
 * A Device Icon
 */
var DeviceIcon = new Lang.Class({
    Name: "GSConnectShellDeviceIcon",
    Extends: St.DrawingArea,
    
    _init: function (device) {
        this.parent({
            width: 48,
            height: 48,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false
        });
        
        this.device = device;
        
        this.tooltip = new Tooltip({
            parent: this,
            markup: this.device.name,
            y_offset: 16
        });
        
        // Device Type
        this._theme = Gtk.IconTheme.get_default();
        this.icon = this._theme.load_surface(this.device.type, 32, 1, null, 0);
        
        this._themeSignal = this._theme.connect("changed", () => {
            this.icon = this._theme.load_surface(this.device.type, 32, 1, null, 0);
            this.queue_repaint();
        });
        
        // Battery Plugin
        if (this.device.battery) {
            this._battery = this.device.battery.connect("notify", () => {
                this.queue_repaint();
            });
        }
        
        this.device.connect("notify::plugins", () => {
            if (this.device.battery && !this._battery) {
                this._battery = this.device.battery.connect("notify", () => {
                    this.queue_repaint();
                });
                this.queue_repaint();
            } else if (!this.device.battery && this._battery) {
                delete this._battery;
            }
        });
        
        // Device Status
        device.connect("notify::connected", () => { this.queue_repaint(); });
        device.connect("notify::paired", () => { this.queue_repaint(); });
        
        this.connect("repaint", Lang.bind(this, this._draw));
        this.connect("destroy", () => {
            this._theme.disconnect(this._themeSignal);
            return true;
        });
    },
    
    _hsv2rgb: function (h, s, v) {
        let r, g, b;
        
        h = h / 360;
        s = s / 100;
        v = v / 100;

        let i = Math.floor(h * 6);
        let f = h * 6 - i;
        let p = v * (1 - s);
        let q = v * (1 - f * s);
        let t = v * (1 - (1 - f) * s);

        switch (i % 6) {
            case 0: r = v, g = t, b = p; break;
            case 1: r = q, g = v, b = p; break;
            case 2: r = p, g = v, b = t; break;
            case 3: r = p, g = q, b = v; break;
            case 4: r = t, g = p, b = v; break;
            case 5: r = v, g = p, b = q; break;
        }
        
        return [r, g, b];
    },
    
    _batteryIcon: function () {
        let {charging, level} = this.device.battery;
        let icon = "battery";
        
        if (level < 0) {
            return "battery-missing-symbolic";
        } else if (level === 100) {
            return "battery-full-charged";
        } else if (level < 3) {
            icon += "-empty";
        } else if (level < 10) {
            icon += "-caution";
        } else if (level < 30) {
            icon += "-low";
        } else if (level < 60) {
            icon += "-good";
        } else if (level >= 60) {
            icon += "-full";
        }
        
        icon += (charging) ? "-charging-symbolic" : "-symbolic";
        
        return icon;
    },
    
    _interpolate: function (high, low, progress) {
        return this._hsv2rgb(
            this.device.battery.level / 100 * 120,
            100,
            100 - (this.device.battery.level / 100 * 15)
        );
    },
    
    _draw: function () {
        if (!this.visible) { return; }
        
        let [width, height] = this.get_surface_size();
        let xc = width / 2;
        let yc = height / 2;
        let rc = Math.min(xc, yc);
        
        let cr = this.get_context();
        let thickness = 3;
        let r = rc - (thickness / 2);
        cr.setLineWidth(thickness);
        
        // Icon
        cr.setSourceSurface(this.icon, xc - 16, yc - 16);
        cr.paint();
        
        if (!this.device.connected) {
            cr.setSourceSurface(this.icon, xc - 16, yc - 16);
            cr.setOperator(Cairo.Operator.EXCLUSION);
            cr.paint();
        
            this.tooltip.markup = _("Reconnect <b>%s</b>").format(this.device.name);
            this.tooltip.icon_name = "view-refresh-symbolic";
            
            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.setOperator(Cairo.Operator.OVER);
            cr.setDash([6, 6], 0); 
            cr.arc(xc, yc, r, 0, 2 * Math.PI);
            cr.stroke();
        } else if (!this.device.paired) {
            this.tooltip.markup = _("Pair <b>%s</b>").format(this.device.name) + "\n\n" + _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.name, this.device.fingerprint, this.device.daemon.fingerprint);
            this.tooltip.icon_name = null;
            
            cr.setSourceRGB(0.95, 0.0, 0.0); // red
            //cr.setSourceRGB(0.96, 0.48, 0.0); // orange
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setDash([3, 7], 0);
            cr.arc(xc, yc, r, 0, 2 * Math.PI);
            cr.stroke();
        } else if (this.device.battery) {
            // Capacity arc
            cr.setSourceRGB(0.8, 0.8, 0.8);
            
            if (this.device.battery.level < 1) {
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
            } else if (this.device.battery.level < 100) {
                let end = (this.device.battery.level / 50 * Math.PI) + 1.5 * Math.PI;
                cr.arcNegative(xc, yc, r, 1.5 * Math.PI, end);
            }
            cr.stroke();
            
            // Remaining arc
            cr.setSourceRGB(...this._interpolate());
            
            if (this.device.battery.level === 100) {
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
                this.tooltip.markup = _("Fully Charged");
            } else if (this.device.battery.level > 0) {
                let end = (this.device.battery.level / 50 * Math.PI) + 1.5 * Math.PI;
                cr.arc(xc, yc, r, 1.5 * Math.PI, end);
                
                if (this.device.battery.charging) {
                    this.tooltip.markup = _("%d%% (Charging)").format(
                        this.device.battery.level
                    );
                } else {
                    this.tooltip.markup = _("%d%% (Discharging)").format(
                        this.device.battery.level
                    );
                }
            }
            this.tooltip.icon_name = this._batteryIcon();
            cr.stroke();
            
            if (this.device.battery.charging) {
                cr.setOperator(Cairo.Operator.DEST_OVER);
                cr.setSourceRGBA(0.43, 0.85, 0.0, 0.25); // green
                cr.arc(xc, yc, r, 0, 2 * Math.PI);
                cr.fill();
            }
        } else {
            this.tooltip.markup = this.device.name;
            this.tooltip.icon_name = null;
            cr.setSourceRGB(0.8, 0.8, 0.8);
            cr.arc(xc, yc, r, 0, 2 * Math.PI);
            cr.stroke();
        }
        
        cr.$dispose();
    }
});


/** An St.Button subclass for buttons with an image and an action */
var DeviceButton = new Lang.Class({
    Name: "GSConnectShellDeviceButton",
    Extends: St.Button,
    
    _init: function (device) {
        this.parent({
            style_class: "system-menu-action gsconnect-device-button",
            child: new DeviceIcon(device),
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_align: St.Align.START,
            y_fill: false,
            y_expand: false
        });
        this.set_y_align(Clutter.ActorAlign.START);
        
        this.device = device;
        
        this.connect("clicked", () => {
            if (!this.device.connected) {
                this.device.activate();
            } else if (!this.device.paired) {
                this.device.pair();
            } else {
                Common.startPreferences();
            }
        });
    }
});

