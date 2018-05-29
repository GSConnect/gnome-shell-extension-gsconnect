'use strict';

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
    incomingCapabilities: ['kdeconnect.mousepad.request'],
    outgoingCapabilities: [],
    actions: {}
};


/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 *
 * TODO: support outgoing mouse/keyboard events
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMousepadPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'mousepad');

        // See: https://wiki.gnome.org/Accessibility/Wayland#Bugs.2FIssues_We_Must_Address
        if (GLib.getenv('XDG_SESSION_TYPE') === 'wayland') {
            this.destroy();
            throw Error(_('Can\'t run in Wayland session'));
        }

        // Sometimes AT-SPI goes down and there's nothing we can do about that
        let ret = Atspi.init();

        if (ret !== 0 && ret !== 1) {
            this.destroy();
            throw Error(_('Failed to initialize Atspi'));
        }

        this._display = Gdk.Display.get_default();

        if (this._display === null) {
            this.destroy();
            throw Error(_('Failed to get Gdk.Display'));
        } else {
            this._seat = this._display.get_default_seat();
            this._pointer = this._seat.get_pointer();
        }

        // Try import Caribou
        try {
            const Caribou = imports.gi.Caribou;
            this._vkbd = Caribou.DisplayAdapter.get_default();
        } catch (e) {
            warning(`Mousepad: Failed load unicode support: ${e.message}`);
        }
    }

    handlePacket(packet) {
        debug(packet);

        if (packet.type === 'kdeconnect.mousepad.request') {
            this._handleInput(packet);
        }
    }

    /**
     * Local Methods
     */
    _handleInput(packet) {
        switch (true) {
            case packet.body.hasOwnProperty('scroll'):
                if (packet.body.dy < 0) {
                    this.clickPointer(5);
                } else if (packet.body.dy > 0) {
                    this.clickPointer(4);
                }
                break;

            case (packet.body.hasOwnProperty('dx') && packet.body.hasOwnProperty('dy')):
                this.movePointer(packet.body.dx, packet.body.dy);
                break;

            case (packet.body.hasOwnProperty('key') || packet.body.hasOwnProperty('specialKey')):
                if (this._vkbd ) {
                    // Set Gdk.ModifierType
                    let mask = 0;

                    switch (true) {
                        case packet.body.ctrl:
                            mask |= Gdk.ModifierType.CONTROL_MASK;
                        case packet.body.shift:
                            mask |= Gdk.ModifierType.SHIFT_MASK;
                        case packet.body.alt:
                            mask |= Gdk.ModifierType.MOD1_MASK;
                        case packet.body.super:
                            mask |= Gdk.ModifierType.SUPER_MASK;
                    }

                    // Transform key to keysym
                    let keysym;

                    if (packet.body.key && packet.body.key !== '\u0000') {
                        keysym = Gdk.unicode_to_keyval(packet.body.key.codePointAt(0));
                    } else if (packet.body.specialKey && KeyMap.has(packet.body.specialKey)) {
                        keysym = KeyMap.get(packet.body.specialKey);
                    }

                    this.pressKeySym(keysym, mask);
                } else {
                    // This is sometimes sent in advance of a specialKey packet
                    if (packet.body.key && packet.body.key !== '\u0000') {
                        this.pressKey(packet.body.key);
                    } else if (packet.body.specialKey) {
                        this.pressSpecialKey(packet.body.specialKey);
                    }
                }
                break;

            case packet.body.hasOwnProperty('singleclick'):
                this.clickPointer(1);
                break;

            case packet.body.hasOwnProperty('doubleclick'):
                this.doubleclickPointer(1);
                break;

            case packet.body.hasOwnProperty('middleclick'):
                this.clickPointer(2);
                break;

            case packet.body.hasOwnProperty('rightclick'):
                this.clickPointer(3);
                break;

            case packet.body.hasOwnProperty('singlehold'):
                this.pressPointer(1);
                break;

            // This is not used, hold is released with a regular click instead
            case packet.body.hasOwnProperty('singlerelease'):
                this.releasePointer(1);
                break;
        }
    }

    clickPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, `b${button}c`);
        } catch (e) {
            logError(e);
        }
    }

    doubleclickPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, `b${button}d`);
        } catch (e) {
            logError(e);
        }
    }

    movePointer(dx, dy) {
        try {
            Atspi.generate_mouse_event(dx, dy, 'rel');
        } catch (e) {
            logError(e);
        }
    }

    pressPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, `b${button}p`);
        } catch (e) {
            logError(e);
        }
    }

    releasePointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            Atspi.generate_mouse_event(x, y, `b${button}r`);
        } catch (e) {
            logError(e);
        }
    }

    pressKey(key) {
        try {
            Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING);
        } catch (e) {
            logError(e);
        }
    }

    pressSpecialKey(key) {
        try {
            if (!KeyMap.has(key) || key === 0) {
                throw Error('Unknown/invalid key');
            }

            Atspi.generate_keyboard_event(
                KeyMap.get(key),
                null,
                Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
            );
        } catch (e) {
            logError(e);
        }
    }

    pressKeySym(keysym, mask) {
        debug('Mousepad: pressKeySym(' + keysym + ', ' + mask + ')');

        try {
            if (Gdk.keyval_to_unicode(keysym) !== 0) {
                this._vkbd.mod_lock(mask);
                this._vkbd.keyval_press(keysym);
                this._vkbd.keyval_release(keysym);
                this._vkbd.mod_unlock(mask);
            }
        } catch (e) {
            logError(e);
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

