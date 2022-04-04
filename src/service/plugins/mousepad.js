// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const {InputDialog} = imports.service.ui.mousepad;
const PluginBase = imports.service.plugin;

// decide if it is under gnome-shell
var HAVE_GNOME = true;
try {
// eslint-disable-next-line no-unused-expressions
    imports.ui;
} catch (e) {
    debug('Not under gnome-shell');
    HAVE_GNOME = false;
    imports.wl_clipboard.watchService();
}
var Metadata = {
    label: _('Mousepad'),
    description: _('Enables the paired device to act as a remote mouse and keyboard'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
    incomingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
    ],
    outgoingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
    ],
    actions: {
        keyboard: {
            label: _('Remote Input'),
            icon_name: 'input-keyboard-symbolic',

            parameter_type: null,
            incoming: [
                'kdeconnect.mousepad.echo',
                'kdeconnect.mousepad.keyboardstate',
            ],
            outgoing: ['kdeconnect.mousepad.request'],
        },
    },
};

/**
 * A map of "KDE Connect" keyvals to Gdk
 */
const KeyMap = new Map([
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

const KeyMapCodes = new Map([
    [1, 14],
    [2, 15],
    [3, 101],
    [4, 105],
    [5, 103],
    [6, 106],
    [7, 108],
    [8, 104],
    [9, 109],
    [10, 102],
    [11, 107],
    [12, 28],
    [13, 111],
    [14, 1],
    [15, 99],
    [16, 70],
    [17, 0],
    [18, 0],
    [19, 0],
    [20, 0],
    [21, 59],
    [22, 60],
    [23, 61],
    [24, 62],
    [25, 63],
    [26, 64],
    [27, 65],
    [28, 66],
    [29, 67],
    [30, 68],
    [31, 87],
    [32, 88],
]);

/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 *
 * TODO: support outgoing mouse events?
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMousepadPlugin',
    Properties: {
        'state': GObject.ParamSpec.boolean(
            'state',
            'State',
            'Remote keyboard state',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
}, class Plugin extends PluginBase.Plugin {
    _init(device) {
        super._init(device, 'mousepad');

        if (!HAVE_GNOME)
            this._input = Components.acquire('ydotool');
        else
            this._input = Components.acquire('input');

        this._shareControlChangedId = this.settings.connect(
            'changed::share-control',
            this._sendState.bind(this)
        );
    }

    get state() {
        if (this._state === undefined)
            this._state = false;

        return this._state;
    }

    connected() {
        super.connected();

        this._sendState();
    }

    disconnected() {
        super.disconnected();

        this._state = false;
        this.notify('state');
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.mousepad.request':
                this._handleInput(packet.body);
                break;

            case 'kdeconnect.mousepad.echo':
                this._handleEcho(packet.body);
                break;

            case 'kdeconnect.mousepad.keyboardstate':
                this._handleState(packet);
                break;
        }
    }

    /**
     * Handle a input event.
     *
     * @param {Object} input - The body of a `kdeconnect.mousepad.request`
     */
    _handleInput(input) {
        if (!this.settings.get_boolean('share-control'))
            return;

        let keysym;
        let modifiers = 0;
        const modifiers_codes = [];

        // These are ordered, as much as possible, to create the shortest code
        // path for high-frequency, low-latency events (eg. mouse movement)
        switch (true) {
            case input.hasOwnProperty('scroll'):
                this._input.scrollPointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('dx') && input.hasOwnProperty('dy')):
                this._input.movePointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('key') || input.hasOwnProperty('specialKey')):
                // NOTE: \u0000 sometimes sent in advance of a specialKey packet
                if (input.key && input.key === '\u0000')
                    return;

                // Modifiers
                if (input.alt) {
                    modifiers |= Gdk.ModifierType.MOD1_MASK;
                    modifiers_codes.push(56);
                }

                if (input.ctrl) {
                    modifiers |= Gdk.ModifierType.CONTROL_MASK;
                    modifiers_codes.push(29);
                }

                if (input.shift) {
                    modifiers |= Gdk.ModifierType.SHIFT_MASK;
                    modifiers_codes.push(42);
                }

                if (input.super) {
                    modifiers |= Gdk.ModifierType.SUPER_MASK;
                    modifiers_codes.push(125);
                }

                // Regular key (printable ASCII or Unicode)
                if (input.key) {
                    if (!HAVE_GNOME)
                        this._input.pressKeys(input.key, modifiers_codes);
                    else
                        this._input.pressKeys(input.key, modifiers);

                    this._sendEcho(input);

                // Special key (eg. non-printable ASCII)
                } else if (input.specialKey && KeyMap.has(input.specialKey)) {
                    if (!HAVE_GNOME) {
                        keysym = KeyMapCodes.get(input.specialKey);
                        this._input.pressKeys(keysym, modifiers_codes);
                    } else {
                        keysym = KeyMap.get(input.specialKey);
                        this._input.pressKeys(keysym, modifiers);
                    }

                    this._sendEcho(input);
                }
                break;

            case input.hasOwnProperty('singleclick'):
                this._input.clickPointer(Gdk.BUTTON_PRIMARY);
                break;

            case input.hasOwnProperty('doubleclick'):
                this._input.doubleclickPointer(Gdk.BUTTON_PRIMARY);
                break;

            case input.hasOwnProperty('middleclick'):
                this._input.clickPointer(Gdk.BUTTON_MIDDLE);
                break;

            case input.hasOwnProperty('rightclick'):
                this._input.clickPointer(Gdk.BUTTON_SECONDARY);
                break;

            case input.hasOwnProperty('singlehold'):
                this._input.pressPointer(Gdk.BUTTON_PRIMARY);
                break;

            case input.hasOwnProperty('singlerelease'):
                this._input.releasePointer(Gdk.BUTTON_PRIMARY);
                break;

            default:
                logError(new Error('Unknown input'));
        }
    }

    /**
     * Handle an echo/ACK of a event we sent, displaying it the dialog entry.
     *
     * @param {Object} input - The body of a `kdeconnect.mousepad.echo`
     */
    _handleEcho(input) {
        if (!this._dialog || !this._dialog.visible)
            return;

        // Skip modifiers
        if (input.alt || input.ctrl || input.super)
            return;

        if (input.key) {
            this._dialog._isAck = true;
            this._dialog.entry.buffer.text += input.key;
            this._dialog._isAck = false;
        } else if (KeyMap.get(input.specialKey) === Gdk.KEY_BackSpace) {
            this._dialog.entry.emit('backspace');
        }
    }

    /**
     * Handle a state change from the remote keyboard. This is an indication
     * that the remote keyboard is ready to accept input.
     *
     * @param {Object} packet - A `kdeconnect.mousepad.keyboardstate` packet
     */
    _handleState(packet) {
        this._state = !!packet.body.state;
        this.notify('state');
    }

    /**
     * Send an echo/ACK of @input, if requested
     *
     * @param {Object} input - The body of a 'kdeconnect.mousepad.request'
     */
    _sendEcho(input) {
        if (!input.sendAck)
            return;

        delete input.sendAck;
        input.isAck = true;

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.echo',
            body: input,
        });
    }

    /**
     * Send the local keyboard state
     *
     * @param {boolean} state - Whether we're ready to accept input
     */
    _sendState() {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.keyboardstate',
            body: {
                state: this.settings.get_boolean('share-control'),
            },
        });
    }

    /**
     * Open the Keyboard Input dialog
     */
    keyboard() {
        if (this._dialog === undefined) {
            this._dialog = new InputDialog({
                device: this.device,
                plugin: this,
            });
        }

        this._dialog.present();
    }

    destroy() {
        if (this._input !== undefined) {
            if (!HAVE_GNOME)
                this._input = Components.release('ydotool');
            else
                this._input = Components.release('input');
        }

        if (this._dialog !== undefined)
            this._dialog.destroy();

        this.settings.disconnect(this._shareControlChangedId);

        super.destroy();
    }
});
