"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Remote Input"),
    description: _("Control the mouse and keyboard remotely"),
    dbusInterface: "org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad",
    schemaId: "org.gnome.shell.extensions.gsconnect.plugin.mousepad",
    incomingPackets: ["kdeconnect.mousepad.request"],
    outgoingPackets: []
};


/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
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
        Common.debug("Mousepad: handlePacket()");
        
        if (packet.body.hasOwnProperty("singleclick")) {
            this.clickPointer(1);
        } else if (packet.body.hasOwnProperty("doubleclick")) {
            this.clickPointer(1, true);
        } else if (packet.body.hasOwnProperty("middleclick")) {
            this.clickPointer(2);
        } else if (packet.body.hasOwnProperty("rightclick")) {
            this.clickPointer(3);
        } else if (packet.body.hasOwnProperty("dx") && packet.body.hasOwnProperty("dy")) {
            this.movePointer(packet.body.dx, packet.body.dy);
        } else if (packet.body.hasOwnProperty("key")) {
            this.pressKey(packet.body.key);
        } else if (packet.body.hasOwnProperty("specialKey")) {
            this.pressSpecialKey(packet.body.specialKey);
        }
    },
    
    clickPointer: function (button, double=false) {
        Common.debug("Mousepad: clickPointer(" + button + ", " + double + ")");
        
        let event;
        
        if (button === 1) {
            event = "b1c";
        } else if (button === 2) {
            event = "b2c";
        } else if (button === 3) {
            event = "b3c";
        }
        
        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, event);
            if (double) { Atspi.generate_mouse_event(x, y, event); }
        } catch (e) {
            log("Mousepad: Error simulating mouse click: " + e);
        }
    },
    
    movePointer: function (dx, dy) {
        Common.debug("Mousepad: movePointer(" + dx + ", " + dy + ")");
        
        try {
            Atspi.generate_mouse_event(dx, dy, "rel");
        } catch (e) {
            log("Mousepad: Error simulating mouse movement: " + e);
        }
    },
    
    // TODO: apparently sends:
    //           {"key":"\u0000"}
    //       then:
    //           {"shift":true,"key":"Q"}
    pressKey: function (key) {
        Common.debug("Mousepad: pressKey(" + key + ")");
        
        try {
            Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING);
        } catch (e) {
            log("Mousepad: Error simulating keypress: " + e);
        }
    },
    
    pressSpecialKey: function (key) {
        Common.debug("Mousepad: pressSpecialKey(" + key + ")");
        
        try {
            if (!KeyMap.has(key) || key === 0) {
                log("Mousepad: Unknown/invalid key");
            }
            
            Atspi.generate_keyboard_event(
                KeyMap.get(key),
                null,
                Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
            );
        } catch (e) {
            log("Mousepad: Error simulating special keypress: " + e);
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

