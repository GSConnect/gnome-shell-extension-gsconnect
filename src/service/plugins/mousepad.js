"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Remote Input"),
    description: _("Control the mouse and keyboard remotely"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad",
    incomingPackets: ["kdeconnect.mousepad.request"],
    outgoingPackets: []
};


/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 *
 * TODO: support outgoing mouse/keyboard events?
 *       kdeconnect-android 1.7+ supposedly supports keyboard events
 */
var Plugin = new Lang.Class({
    Name: "GSConnectMousepadPlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "mousepad");

        if (GLib.getenv("XDG_SESSION_TYPE") === "wayland") {
            this.destroy();
            throw Error(_("Can't run in Wayland session"));
        }

        let ret = Atspi.init();

        if (ret !== 0 && ret !== 1) {
            this.destroy();
            throw Error(_("Failed to initialize Atspi"));
        }

        this._display = Gdk.Display.get_default();
        
        if (this._display === null) {
            this.destroy();
            throw Error(_("Failed to get Gdk.Display"));
        } else {
            this._seat = this._display.get_default_seat();
            this._pointer = this._seat.get_pointer();
        }

        // Try import Caribou
        try {
            const Caribou = imports.gi.Caribou;
            this.vkbd = Caribou.DisplayAdapter.get_default();
        } catch (e) {
            debug(_("Cannot load Caribou virtual keyboard for Unicode support"));
        }
    },

    handlePacket: function (packet) {
        debug("Mousepad: handlePacket()");

        if (packet.body.singleclick) {
            this.clickPointer(1);
        } else if (packet.body.doubleclick) {
            this.doubleclickPointer(1);
        } else if (packet.body.middleclick) {
            this.clickPointer(2);
        } else if (packet.body.rightclick) {
            this.clickPointer(3);
        } else if (packet.body.singlehold) {
            this.pressPointer(1);
        } else if (packet.body.singlerelease) {
            // This is not used, hold is released with a regular click instead
            this.releasePointer(1);
        } else if (packet.body.scroll) {
            if (packet.body.dy < 0) {
                this.clickPointer(5);
            } else if (packet.body.dy > 0) {
                this.clickPointer(4);
            }
        } else if (packet.body.hasOwnProperty("dx") && packet.body.hasOwnProperty("dy")) {
            this.movePointer(packet.body.dx, packet.body.dy);
        } else if (packet.body.key || packet.body.specialKey) {
            if (this.vkbd ) {
                // Set Gdk.ModifierType
                let mask = 0;
                if (packet.body.ctrl)  { mask |= Gdk.ModifierType.CONTROL_MASK; }
                if (packet.body.shift) { mask |= Gdk.ModifierType.SHIFT_MASK; }
                if (packet.body.alt)   { mask |= Gdk.ModifierType.MOD1_MASK; }  // Alt key
                if (packet.body.super) { mask |= Gdk.ModifierType.SUPER_MASK; } // Super key

                // Transform key to keysym
                let keysym;
                if (packet.body.key && packet.body.key !== "\u0000") {
                    keysym = Gdk.unicode_to_keyval(packet.body.key.codePointAt(0));
                } else if (packet.body.specialKey && KeyMap.has(packet.body.specialKey)) {
                    keysym = KeyMap.get(packet.body.specialKey);
                }
                
                this.pressKeySym(keysym, mask);
            } else {
                // This is sometimes sent in advance of a specialKey packet
                if (packet.body.key && packet.body.key !== "\u0000") {
                    this.pressKey(packet.body.key);
                } else if (packet.body.specialKey) {
                    this.pressSpecialKey(packet.body.specialKey);
                }
            }
        }
    },

    clickPointer: function (button) {
        debug("Mousepad: clickPointer(" + button + ")");

        let event = "b%dc".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse click: " + e);
        }
    },

    doubleclickPointer: function (button) {
        debug("Mousepad: doubleclickPointer(" + button + ")");

        let event = "b%dd".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse double click: " + e);
        }
    },

    movePointer: function (dx, dy) {
        debug("Mousepad: movePointer(" + dx + ", " + dy + ")");

        try {
            Atspi.generate_mouse_event(dx, dy, "rel");
        } catch (e) {
            log("Mousepad: Error simulating mouse movement: " + e);
        }
    },

    pressPointer: function (button) {
        debug("Mousepad: pressPointer()");

        let event = "b%dp".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse press: " + e);
        }
    },

    releasePointer: function (button) {
        debug("Mousepad: releasePointer()");

        let event = "b%dr".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse release: " + e);
        }
    },

    pressKey: function (key) {
        debug("Mousepad: pressKey(" + key + ")");

        try {
            if ( !Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING) ) {
                throw Error("Unknown/invalid key");
            };
        } catch (e) {
            log("Mousepad: Error simulating keypress: " + e);
        }
    },

    pressSpecialKey: function (key) {
        debug("Mousepad: pressSpecialKey(" + key + ")");

        try {
            if (!KeyMap.has(key) || key === 0) {
                throw Error("Unknown/invalid key");
            }

            Atspi.generate_keyboard_event(
                KeyMap.get(key),
                null,
                Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
            );
        } catch (e) {
            log("Mousepad: Error simulating special keypress: " + e);
        }
    },
    
    pressKeySym: function (keysym, mask) {
        debug("Mousepad: pressKeySym(" + keysym + ", " + mask + ")");

        try {
            if (Gdk.keyval_to_unicode(keysym) !== 0) {
                this.vkbd.mod_lock(mask);
                this.vkbd.keyval_press(keysym);
                this.vkbd.keyval_release(keysym);
                this.vkbd.mod_unlock(mask);
            }
        } catch (e) {
            log("Mousepad: Error simulating keyboard event with virtual keyboard: " + e);
        }
    }
});


var KeyMap = new Map([
    [0, 0], // Invalid: pressSpecialKey throws error
    [1, Gdk.KEY_BackSpace],
    [2, Gdk.KEY_Tab],
    [3, Gdk.KEY_Linefeed],
    [4, Gdk.KEY_Left],
    [5, Gdk.KEY_Up],
    [6, Gdk.KEY_Right],
    [7, Gdk.KEY_Down],
    [8, Gdk.KEY_Page_Up],
    [9, Gdk.KEY_Page_Down],
    [10, Gdk.KEY_Home],
    [11, Gdk.KEY_End],
    [12, Gdk.KEY_Return],
    [13, Gdk.KEY_Delete],
    [14, Gdk.KEY_Escape],
    [15, Gdk.KEY_Sys_Req],
    [16, Gdk.KEY_Scroll_Lock],
    [17, 0],
    [18, 0],
    [19, 0],
    [20, 0],
    [21, Gdk.KEY_F1],
    [22, Gdk.KEY_F2],
    [23, Gdk.KEY_F3],
    [24, Gdk.KEY_F4],
    [25, Gdk.KEY_F5],
    [26, Gdk.KEY_F6],
    [27, Gdk.KEY_F7],
    [28, Gdk.KEY_F8],
    [29, Gdk.KEY_F9],
    [30, Gdk.KEY_F10],
    [31, Gdk.KEY_F11],
    [32, Gdk.KEY_F12],
]);
