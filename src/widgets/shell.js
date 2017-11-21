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
var TOOLTIP_BROWSE_ID = 0;
var TOOLTIP_BROWSE_MODE = false;

var Tooltip = new Lang.Class({
    Name: "GSConnectShellTooltip",
    
    _init: function (params) {
        params = Object.assign({
            parent: null,
            title: "",
            x_offset: 0,
            y_offset: 0
        }, params);
    
        this._parent = params.parent;
        this.title = params.title;
        this.x_offset = params.x_offset;
        this.y_offset = params.y_offset;
        
        if (!this._parent) {
            throw Error(this.Name + ": arg parent must not be null");
        }
        
        this._hoverTimeout = 0;
        this._showing = false;
        
        this.bin = null;
        this.label = null;
        
        try {
            this._parent.connect("clicked", Lang.bind(this, this.hover));
        } catch (e) {
            this._parent.connect("button-release-event", Lang.bind(this, this.hover));
        }
        
        this._parent.connect("destroy", Lang.bind(this, this.destroy));
        
        // TODO: oddly fuzzy on menu items, sometimes
        if (this._parent.actor) { this._parent = this._parent.actor; }
        this._parent.connect("notify::hover", Lang.bind(this, this.hover));
    },
    
    show: function () {
        if (!this.bin) {
            this.bin = new St.Bin({
                style_class: "osd-window gsconnect-tooltip",
                opacity: 232
            });
            
            this.label = new St.Label({
                style_class: "gsconnect-tooltip-text",
                text: this.title
            });
            this.label.clutter_text.line_wrap = true;
            this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
            this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.label.clutter_text.use_markup = true;
            this.bin.child = this.label;
            
            Main.layoutManager.uiGroup.add_actor(this.bin);
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bin, null);
        } else {
            this.label.clutter_text.text = this.title;
        }
        
        // TODO: if tooltip is too big it can overshoot the screen edge
        let [x, y] = this._parent.get_transformed_position();
        x = (x + (this._parent.width/2)) - Math.round(this.bin.width/2);
        
        x += this.x_offset;
        y += this.y_offset;
        
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
    
    hide: function () {
        if (this.bin) {
            Tweener.addTween(this.bin, {
                opacity: 0,
                time: 0.10,
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
        
        if (this._hoverTimeoutId > 0){
            Mainloop.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
        
        TOOLTIP_BROWSE_ID = Mainloop.timeout_add(500, () => {
            TOOLTIP_BROWSE_MODE = false;
            TOOLTIP_BROWSE_ID = 0;
            return false;
        });
        
        if (this._showing) {
            this._showing = false;
            this._hoverTimeoutId = 0;
        }
    },
    
    hover: function () {
        if (this._parent.hover) {
            if (!this._hoverTimeoutId) {
                if (this._showing) {
                    this.show();
                } else if (TOOLTIP_BROWSE_MODE) {
                    this._hoverTimeoutId = Mainloop.timeout_add(60, () => {
                        this.show();
                        this._hoverTimeoutId = 0;
                        return false;
                    });
                } else {
                    this._hoverTimeoutId = Mainloop.timeout_add(500, () => {
                        this.show();
                        this._hoverTimeoutId = 0;
                        return false;
                    });
                }
            }
        } else {
            this.hide();
        }
    },
    
    destroy: function () {
        this.hide();
    }
});


/** An St.Button subclass for buttons with an image and an action */
var PluginButton = new Lang.Class({
    Name: "GSConnectShellPluginButton",
    Extends: St.Button,
    
    _init: function (params) {
        params = Object.assign({
            icon_name: "application-x-executable",
            callback: () => {},
            toggle_mode: false,
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
        
        if (typeof params.tooltip_text === "string") {
            this.tooltip = new Tooltip({
                parent: this,
                title: params.tooltip_text
            });
            this.connect("destroy", () => { this.tooltip.destroy(); });
        }
    }
});

