'use strict';

imports.gi.versions.Atspi = '2.0';

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;


/**
 * Printable ASCII range
 */
const _ASCII = /[\x20-\x7E]/;


/**
 * Modifier Keycode Defaults
 */
const XKeycode = {
    Alt_L: 0x40,
    Control_L: 0x25,
    Shift_L: 0x32,
    Super_L: 0x85,
};


/**
 * A thin wrapper around Atspi for X11 sessions without Pipewire support.
 */
var Controller = class {
    constructor() {
        // Atspi.init() return 2 on fail, but still marks itself as inited. We
        // uninit before throwing an error otherwise any future call to init()
        // will appear successful and other calls will cause GSConnect to exit.
        // See: https://gitlab.gnome.org/GNOME/at-spi2-core/blob/master/atspi/atspi-misc.c
        if (Atspi.init() === 2) {
            this.destroy();
            throw new Error('Failed to start AT-SPI');
        }

        try {
            this._display = Gdk.Display.get_default();
            this._seat = this._display.get_default_seat();
            this._pointer = this._seat.get_pointer();
        } catch (e) {
            this.destroy();
            throw e;
        }

        // Try to read modifier keycodes from Gdk
        try {
            const keymap = Gdk.Keymap.get_for_display(this._display);
            let modifier;

            modifier = keymap.get_entries_for_keyval(Gdk.KEY_Alt_L)[1][0];
            XKeycode.Alt_L = modifier.keycode;

            modifier = keymap.get_entries_for_keyval(Gdk.KEY_Control_L)[1][0];
            XKeycode.Control_L = modifier.keycode;

            modifier = keymap.get_entries_for_keyval(Gdk.KEY_Shift_L)[1][0];
            XKeycode.Shift_L = modifier.keycode;

            modifier = keymap.get_entries_for_keyval(Gdk.KEY_Super_L)[1][0];
            XKeycode.Super_L = modifier.keycode;
        } catch (e) {
            debug('using default modifier keycodes');
        }
    }

    /*
     * Pointer events
     */
    clickPointer(button) {
        try {
            const [, x, y] = this._pointer.get_position();
            const monitor = this._display.get_monitor_at_point(x, y);
            const scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}c`);
        } catch (e) {
            logError(e);
        }
    }

    doubleclickPointer(button) {
        try {
            const [, x, y] = this._pointer.get_position();
            const monitor = this._display.get_monitor_at_point(x, y);
            const scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}d`);
        } catch (e) {
            logError(e);
        }
    }

    movePointer(dx, dy) {
        try {
            const [, x, y] = this._pointer.get_position();
            const monitor = this._display.get_monitor_at_point(x, y);
            const scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * dx, scale * dy, 'rel');
        } catch (e) {
            logError(e);
        }
    }

    pressPointer(button) {
        try {
            const [, x, y] = this._pointer.get_position();
            const monitor = this._display.get_monitor_at_point(x, y);
            const scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}p`);
        } catch (e) {
            logError(e);
        }
    }

    releasePointer(button) {
        try {
            const [, x, y] = this._pointer.get_position();
            const monitor = this._display.get_monitor_at_point(x, y);
            const scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}r`);
        } catch (e) {
            logError(e);
        }
    }

    scrollPointer(dx, dy) {
        if (dy > 0)
            this.clickPointer(4);
        else if (dy < 0)
            this.clickPointer(5);
    }

    /*
     * Phony virtual keyboard helpers
     */
    _modeLock(keycode) {
        Atspi.generate_keyboard_event(
            keycode,
            null,
            Atspi.KeySynthType.PRESS
        );
    }

    _modeUnlock(keycode) {
        Atspi.generate_keyboard_event(
            keycode,
            null,
            Atspi.KeySynthType.RELEASE
        );
    }

    /*
     * Simulate a printable-ASCII character.
     *
     */
    _pressASCII(key, modifiers) {
        try {
            // Press Modifiers
            if (modifiers & Gdk.ModifierType.MOD1_MASK)
                this._modeLock(XKeycode.Alt_L);
            if (modifiers & Gdk.ModifierType.CONTROL_MASK)
                this._modeLock(XKeycode.Control_L);
            if (modifiers & Gdk.ModifierType.SHIFT_MASK)
                this._modeLock(XKeycode.Shift_L);
            if (modifiers & Gdk.ModifierType.SUPER_MASK)
                this._modeLock(XKeycode.Super_L);

            Atspi.generate_keyboard_event(
                0,
                key,
                Atspi.KeySynthType.STRING
            );

            // Release Modifiers
            if (modifiers & Gdk.ModifierType.MOD1_MASK)
                this._modeUnlock(XKeycode.Alt_L);
            if (modifiers & Gdk.ModifierType.CONTROL_MASK)
                this._modeUnlock(XKeycode.Control_L);
            if (modifiers & Gdk.ModifierType.SHIFT_MASK)
                this._modeUnlock(XKeycode.Shift_L);
            if (modifiers & Gdk.ModifierType.SUPER_MASK)
                this._modeUnlock(XKeycode.Super_L);
        } catch (e) {
            logError(e);
        }
    }

    _pressKeysym(keysym, modifiers) {
        try {
            // Press Modifiers
            if (modifiers & Gdk.ModifierType.MOD1_MASK)
                this._modeLock(XKeycode.Alt_L);
            if (modifiers & Gdk.ModifierType.CONTROL_MASK)
                this._modeLock(XKeycode.Control_L);
            if (modifiers & Gdk.ModifierType.SHIFT_MASK)
                this._modeLock(XKeycode.Shift_L);
            if (modifiers & Gdk.ModifierType.SUPER_MASK)
                this._modeLock(XKeycode.Super_L);

            Atspi.generate_keyboard_event(
                keysym,
                null,
                Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
            );

            // Release Modifiers
            if (modifiers & Gdk.ModifierType.MOD1_MASK)
                this._modeUnlock(XKeycode.Alt_L);
            if (modifiers & Gdk.ModifierType.CONTROL_MASK)
                this._modeUnlock(XKeycode.Control_L);
            if (modifiers & Gdk.ModifierType.SHIFT_MASK)
                this._modeUnlock(XKeycode.Shift_L);
            if (modifiers & Gdk.ModifierType.SUPER_MASK)
                this._modeUnlock(XKeycode.Super_L);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Simulate the composition of a unicode character with:
     *     Control+Shift+u, [hex], Return
     *
     * @param {number} key - An XKeycode
     * @param {number} modifiers - A modifier mask
     */
    _pressUnicode(key, modifiers) {
        try {
            if (modifiers > 0)
                log('GSConnect: ignoring modifiers for unicode keyboard event');

            // TODO: Using Control and Shift keysym is not working (it triggers
            // key release). Probably using LOCKMODIFIERS will not work either
            // as unlocking the modifier will not trigger a release

            // Activate compose sequence
            this._modeLock(XKeycode.Control_L);
            this._modeLock(XKeycode.Shift_L);

            this.pressreleaseKeysym(Gdk.KEY_U);

            this._modeUnlock(XKeycode.Control_L);
            this._modeUnlock(XKeycode.Shift_L);

            // Enter the unicode sequence
            const ucode = key.charCodeAt(0).toString(16);
            let keysym;

            for (let h = 0, len = ucode.length; h < len; h++) {
                keysym = Gdk.unicode_to_keyval(ucode.charAt(h).codePointAt(0));
                this.pressreleaseKeysym(keysym);
            }

            // Finish the compose sequence
            this.pressreleaseKeysym(Gdk.KEY_Return);
        } catch (e) {
            logError(e);
        }
    }

    /*
     * Keyboard Events
     */
    pressKeysym(keysym) {
        Atspi.generate_keyboard_event(
            keysym,
            null,
            Atspi.KeySynthType.PRESS | Atspi.KeySynthType.SYM
        );
    }

    releaseKeysym(keysym) {
        Atspi.generate_keyboard_event(
            keysym,
            null,
            Atspi.KeySynthType.RELEASE | Atspi.KeySynthType.SYM
        );
    }

    pressreleaseKeysym(keysym) {
        Atspi.generate_keyboard_event(
            keysym,
            null,
            Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM
        );
    }

    pressKey(input, modifiers) {
        // We were passed a keysym
        if (typeof input === 'number')
            this._pressKeysym(input, modifiers);

        // Regular ASCII
        else if (_ASCII.test(input))
            this._pressASCII(input, modifiers);

        // Unicode
        else
            this._pressUnicode(input, modifiers);
    }

    destroy() {
        try {
            Atspi.exit();
        } catch (e) {
            // Silence errors
        }
    }
};

