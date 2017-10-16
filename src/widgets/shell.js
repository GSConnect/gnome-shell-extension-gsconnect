"use strict";

// Imports
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Main = imports.ui.main;
const Tweener = imports.ui.tweener;


/** 
 * A Tooltip for ActionButton
 * 
 * Adapted from: https://github.com/RaphaelRochet/applications-overview-tooltip
 */
var Tooltip = new Lang.Class({
    Name: "GSConnectShellTooltip",
    
    _init: function (title, parent) {
        this._parent = parent;
        
        this._hoverTimeout = 0;
        this._labelTimeout = 0;
        this._showing = false;
        
        this.bin = null;
        this.label = null;
        this.title = title;
        
        this._parent.connect("notify::hover", Lang.bind(this, this.hover));
        this._parent.connect("clicked", Lang.bind(this, this.hover));
        this._parent.connect("destroy", Lang.bind(this, this.destroy));
    },
    
    show: function () {
        if (!this.bin) {
            this.label = new St.Label({
                // TODO: rtl
                style: "font-weight: normal; text-align: left;",
                text: this.title
            });
            this.label.clutter_text.line_wrap = true;
            this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
            this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.label.clutter_text.use_markup = true;
            
            this.bin = new St.Bin({
                style_class: "osd-window",
                style: "min-width: 0; min-height: 0; padding: 6px; border-radius: 2px;"
            });
            this.bin.child = this.label;
            
            Main.layoutManager.uiGroup.add_actor(this.bin);
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bin, null);
        } else {
            this.label.clutter_text.text = this.title;
        }
        
        let [x, y] = this._parent.get_transformed_position();
        y = y + 12;
        x = x - Math.round(this.bin.get_width()/2.5);
        
        if (this._showing) {
            Tweener.addTween(this.bin, {
                x: x,
                y: y,
                time: 15/100,
                transition: "easeOutQuad",
            });
        } else {
            this.bin.set_position(x, y);
            Tweener.addTween(this.bin, {
                opacity: 255,
                time: 15/100,
                transition: "easeOutQuad",
            });
            
            this._showing = true;
        }
        
        if (this._hoverTimeout > 0) {
            Mainloop.source_remove(this._hoverTimeout);
            this._hoverTimeout = 0;
        }
    },
    
    hide: function () {
        if (this.bin) {
            Tweener.addTween(this.bin, {
                opacity: 0,
                time: 10/100,
                transition: 'easeOutQuad',
                onComplete: () => {
                    Main.layoutManager.uiGroup.remove_actor(this.bin);
                    this.bin.destroy();
                    this.bin = null;
                    this.label.destroy();
                    this.label = null;
                }
            });
        }
    },
    
    hover: function () {
        if (this._parent.get_hover()) {
            if (this._labelTimeout === 0) {
                if (this._showing) {
                    this.show();
                } else {
                    this._labelTimeout = Mainloop.timeout_add(500, () => {
                        this.show();
                        this._labelTimeout = 0;
                        return false;
                    });
                }
            }
        } else {
            this.leave();
        }
    },
    
    leave: function () {
        if (this._labelTimeout > 0){
            Mainloop.source_remove(this._labelTimeout);
            this._labelTimeout = 0;
        }
        
        if (this._showing) {
            this._hoverTimeout = Mainloop.timeout_add(500, () => {
                    this.hide();
                    this._showing = false;
                    this._hoverTimeout = 0;
                    return false;
            });
        }
    },
    
    destroy: function () {
        this.leave();
    }
});


/** An St.Button subclass for buttons with an image and an action */
var Button = new Lang.Class({
    Name: "GSConnectShellButton",
    Extends: St.Button,
    
    _init: function (params) {
        params = Object.assign({
            icon_name: "application-x-executable",
            callback: () => {},
            toggle_mode: false,
            tooltip_text: false
        }, params);
    
        this.parent({
            style_class: "system-menu-action",
            style: "padding: 8px;",
            child: new St.Icon({ icon_name: params.icon_name }),
            toggle_mode: params.toggle_mode
        });
        
        this.callback = params.callback;
        
        this.connect("clicked", () => {
            this.callback(this)
        });
        
        if (typeof params.tooltip_text === "string") {
            this.tooltip = new Tooltip(params.tooltip_text, this);
            this.connect("destroy", () => { this.tooltip.destroy(); });
        }
    }
});

