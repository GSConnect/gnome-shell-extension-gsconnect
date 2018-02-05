"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad",
    incomingPackets: ["kdeconnect.mousepad.request"],
    outgoingPackets: []
};


/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 *
 * TODO: support outgoing mouse/keyboard events
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
    },

    handlePacket: function (packet) {
        debug(packet);

        return new Promise((resolve, reject) => {
            if (packet.type === "kdeconnect.mousepad.request") {
                resolve(this._handleInput(packet));
            }

            reject(new Error("Unsupported packet"));
        });
    },

    /**
     * Local Methods
     */
    _handleInput: function (packet) {
        if (packet.body.singleclick) {
            this._clickPointer(1);
        } else if (packet.body.doubleclick) {
            this._doubleclickPointer(1);
        } else if (packet.body.middleclick) {
            this._clickPointer(2);
        } else if (packet.body.rightclick) {
            this._clickPointer(3);
        } else if (packet.body.singlehold) {
            this._pressPointer(1);
        } else if (packet.body.singlerelease) {
            // This is not used, hold is released with a regular click instead
            this._releasePointer(1);
        } else if (packet.body.scroll) {
            if (packet.body.dy < 0) {
                this._clickPointer(5);
            } else if (packet.body.dy > 0) {
                this._clickPointer(4);
            }
        } else if (packet.body.hasOwnProperty("dx") && packet.body.hasOwnProperty("dy")) {
            this._movePointer(packet.body.dx, packet.body.dy);
        } else if (packet.body.key) {
            // This is sometimes sent in advance of a specialKey packet
            if (packet.body.key !== "\u0000") {
                this._pressKey(packet.body.key);
            }
        } else if (packet.body.specialKey) {
            this._pressSpecialKey(packet.body.specialKey);
        }

        return true;
    },

    _clickPointer: function (button) {
        debug(button);

        let event = "b%dc".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            return Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse click: " + e);
        }
    },

    _doubleclickPointer: function (button) {
        debug(button);

        let event = "b%dd".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            return Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse double click: " + e);
        }
    },

    _movePointer: function (dx, dy) {
        debug([dx, dy]);

        try {
            return Atspi.generate_mouse_event(dx, dy, "rel");
        } catch (e) {
            log("Mousepad: Error simulating mouse movement: " + e);
        }
    },

    _pressPointer: function (button) {
        debug(button);

        let event = "b%dp".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            return Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse press: " + e);
        }
    },

    _releasePointer: function (button) {
        debug(button);

        let event = "b%dr".format(button);

        try {
            let [screen, x, y] = this._pointer.get_position();
            return Atspi.generate_mouse_event(x, y, event);
        } catch (e) {
            log("Mousepad: Error simulating mouse release: " + e);
        }
    },

    _pressKey: function (key) {
        debug("Mousepad: pressKey(" + key + ")");

        try {
            return Atspi.generate_keyboard_event(
                0,
                key,
                Atspi.KeySynthType.STRING
            );
        } catch (e) {
            log("Mousepad: Error simulating keypress: " + e);
        }
    },

    _pressSpecialKey: function (key) {
        debug("Mousepad: pressSpecialKey(" + key + ")");

        try {
            if (!KeyMap.has(key) || key === 0) {
                throw Error("Unknown/invalid key");
            }

            return Atspi.generate_keyboard_event(
                KeyMap.get(key),
                null,
                Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
            );
        } catch (e) {
            log("Mousepad: Error simulating special keypress: " + e);
        }
    }
});


/**
 * KDE Connect Keymap
 */
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

