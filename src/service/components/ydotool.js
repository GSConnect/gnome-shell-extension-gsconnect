'use strict';

const Gio = imports.gi.Gio;
const Gdk = imports.gi.Gdk;

const keyCodes = new Map([
    ['1', 2],
    ['2', 3],
    ['3', 4],
    ['4', 5],
    ['5', 6],
    ['6', 7],
    ['7', 8],
    ['8', 9],
    ['9', 10],
    ['0', 11],
    ['-', 12],
    ['=', 13],
    ['Q', 16],
    ['W', 17],
    ['E', 18],
    ['R', 19],
    ['T', 20],
    ['Y', 21],
    ['U', 22],
    ['I', 23],
    ['O', 24],
    ['P', 25],
    ['[', 26],
    [']', 27],
    ['A', 30],
    ['S', 31],
    ['D', 32],
    ['F', 33],
    ['G', 34],
    ['H', 35],
    ['J', 36],
    ['K', 37],
    ['L', 38],
    [';', 39],
    ["'", 40],
    ['Z', 44],
    ['X', 45],
    ['C', 46],
    ['V', 47],
    ['B', 48],
    ['N', 49],
    ['M', 50],
    [',', 51],
    ['.', 52],
    ['/', 53],
    ['\\', 43],
]);
class Controller {
    constructor() {
        // laucher for wl-clipboard
        this._launcher = new Gio.SubprocessLauncher({
            flags:
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE,
        });
        this._args = [];
        this.buttonMap = new Map([
            [Gdk.BUTTON_PRIMARY, '0'],
            [Gdk.BUTTON_MIDDLE, '2'],
            [Gdk.BUTTON_SECONDARY, '1'],
        ]);
    }

    get args() {
        return this._args;
    }

    set args(opts) {
        this._args = ['ydotool'].concat(opts);
        try {
            this._launcher.spawnv(this._args);
        } catch (e) {
            debug(e, this._args);
        }
    }

    /*
     * Pointer Events
     */
    movePointer(dx, dy) {
        if (dx === 0 && dy === 0)
            return;
        this.args = ['mousemove', '--', dx.toString(), dy.toString()];
    }

    pressPointer(button) {
        this.args = ['click', '0x4' + this.buttonMap.get(button)];
    }

    releasePointer(button) {
        this.args = ['click', '0x8' + this.buttonMap.get(button)];
    }

    clickPointer(button) {
        this.args = ['click', '0xC' + this.buttonMap.get(button)];
    }

    doubleclickPointer(button) {
        this.args = [
            'click',
            '0xC' + this.buttonMap.get(button),
            'click',
            '0xC' + this.buttonMap.get(button),
        ];
    }

    scrollPointer(dx, dy) {
        if (dx === 0 && dy === 0)
            return;
        this.args = ['mousemove', '-w', '--', dx.toString(), dy.toString()];
    }

    /*
     * Keyboard Events
     */

    pressKeys(input, modifiers_codes) {
        if (typeof input === 'string' && modifiers_codes.length === 0) {
            try {
                this._launcher.spawnv(['wtype', input]);
            } catch (e) {
                debug(e);
                this.arg = ['type', '--', input];
            }
        } else {
            if (typeof input === 'number') {
                modifiers_codes.push(input);
            } else if (typeof input === 'string') {
                input = input.toUpperCase();
                for (var i = 0; i < input.length; i++) {
                    if (keyCodes.get(input[i])) {
                        modifiers_codes.push(keyCodes.get(input[i]));
                    } else {
                        debug('Keycode for ' + input[i] + ' not found');
                        return;
                    }
                }

            }
            this._args = ['key'];
            modifiers_codes.forEach((code) => this._args.push(code + ':1'));
            modifiers_codes
                .reverse()
                .forEach((code) => this._args.push(code + ':0'));
            this.args = this._args;
        }
    }

    destroy() {
        this._args = [];
    }
}

/**
 * The service class for this component
 */
var Component = Controller;
