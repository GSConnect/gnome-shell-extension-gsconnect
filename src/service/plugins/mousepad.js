'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Mousepad'),
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
            label: _('Keyboard'),
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
                if (input.alt)
                    modifiers |= Gdk.ModifierType.MOD1_MASK;

                if (input.ctrl)
                    modifiers |= Gdk.ModifierType.CONTROL_MASK;

                if (input.shift)
                    modifiers |= Gdk.ModifierType.SHIFT_MASK;

                if (input.super)
                    modifiers |= Gdk.ModifierType.SUPER_MASK;

                // Regular key (printable ASCII or Unicode)
                if (input.key) {
                    this._input.pressKey(input.key, modifiers);
                    this._sendEcho(input);

                // Special key (eg. non-printable ASCII)
                } else if (input.specialKey && KeyMap.has(input.specialKey)) {
                    keysym = KeyMap.get(input.specialKey);
                    this._input.pressKey(keysym, modifiers);
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
            this._dialog.text.buffer.text += input.key;
            this._dialog._isAck = false;
        } else if (KeyMap.get(input.specialKey) === Gdk.KEY_BackSpace) {
            this._dialog.text.emit('backspace');
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
            this._dialog = new KeyboardInputDialog({
                device: this.device,
                plugin: this,
            });
        }

        this._dialog.present();
    }

    destroy() {
        if (this._input !== undefined)
            this._input = Components.release('input');

        if (this._dialog !== undefined)
            this._dialog.destroy();

        this.settings.disconnect(this._shareControlChangedId);

        super.destroy();
    }
});


/**
 * A map of Gdk to "KDE Connect" keyvals
 */
const ReverseKeyMap = new Map([
    [Gdk.KEY_BackSpace, 1],
    [Gdk.KEY_Tab, 2],
    [Gdk.KEY_Linefeed, 3],
    [Gdk.KEY_Left, 4],
    [Gdk.KEY_Up, 5],
    [Gdk.KEY_Right, 6],
    [Gdk.KEY_Down, 7],
    [Gdk.KEY_Page_Up, 8],
    [Gdk.KEY_Page_Down, 9],
    [Gdk.KEY_Home, 10],
    [Gdk.KEY_End, 11],
    [Gdk.KEY_Return, 12],
    [Gdk.KEY_Delete, 13],
    [Gdk.KEY_Escape, 14],
    [Gdk.KEY_Sys_Req, 15],
    [Gdk.KEY_Scroll_Lock, 16],
    [Gdk.KEY_F1, 21],
    [Gdk.KEY_F2, 22],
    [Gdk.KEY_F3, 23],
    [Gdk.KEY_F4, 24],
    [Gdk.KEY_F5, 25],
    [Gdk.KEY_F6, 26],
    [Gdk.KEY_F7, 27],
    [Gdk.KEY_F8, 28],
    [Gdk.KEY_F9, 29],
    [Gdk.KEY_F10, 30],
    [Gdk.KEY_F11, 31],
    [Gdk.KEY_F12, 32],
]);


/*
 * A list of keyvals we consider modifiers
 */
const MOD_KEYS = [
    Gdk.KEY_Alt_L,
    Gdk.KEY_Alt_R,
    Gdk.KEY_Caps_Lock,
    Gdk.KEY_Control_L,
    Gdk.KEY_Control_R,
    Gdk.KEY_Meta_L,
    Gdk.KEY_Meta_R,
    Gdk.KEY_Num_Lock,
    Gdk.KEY_Shift_L,
    Gdk.KEY_Shift_R,
    Gdk.KEY_Super_L,
    Gdk.KEY_Super_R,
];


/*
 * Some convenience functions for checking keyvals for modifiers
 */
const isAlt = (key) => [Gdk.KEY_Alt_L, Gdk.KEY_Alt_R].includes(key);
const isCtrl = (key) => [Gdk.KEY_Control_L, Gdk.KEY_Control_R].includes(key);
const isShift = (key) => [Gdk.KEY_Shift_L, Gdk.KEY_Shift_R].includes(key);
const isSuper = (key) => [Gdk.KEY_Super_L, Gdk.KEY_Super_R].includes(key);


var KeyboardInputDialog = GObject.registerClass({
    GTypeName: 'GSConnectMousepadKeyboardInputDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The mousepad plugin associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
    },
}, class KeyboardInputDialog extends Gtk.Dialog {

    _init(params) {
        super._init(Object.assign({
            use_header_bar: true,
            default_width: 480,
            window_position: Gtk.WindowPosition.CENTER,
        }, params));

        let headerbar = this.get_titlebar();
        headerbar.title = _('Keyboard');
        headerbar.subtitle = this.device.name;

        // Main Box
        let content = this.get_content_area();
        content.border_width = 0;

        // Infobar
        this.infobar = new Gtk.Revealer();
        content.add(this.infobar);

        let bar = new Gtk.InfoBar({message_type: Gtk.MessageType.WARNING});
        this.infobar.add(bar);

        let infoicon = new Gtk.Image({icon_name: 'dialog-warning-symbolic'});
        bar.get_content_area().add(infoicon);

        let infolabel = new Gtk.Label({
            // TRANSLATORS: Displayed when the remote keyboard is not ready to accept input
            label: _('Remote keyboard on %s is not active').format(this.device.name),
        });
        bar.get_content_area().add(infolabel);

        let infolink = new Gtk.LinkButton({
            label: _('Help'),
            uri: 'https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Help#remote-keyboard-not-active',
        });
        bar.get_action_area().add(infolink);

        // Content
        let layout = new Gtk.Grid({
            column_spacing: 6,
            margin: 6,
        });
        content.add(layout);

        // Modifier Buttons
        this.shift_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.SHIFT_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false,
        });
        layout.attach(this.shift_label, 0, 0, 1, 1);

        this.ctrl_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.CONTROL_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false,
        });
        layout.attach(this.ctrl_label, 0, 1, 1, 1);

        this.alt_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.MOD1_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false,
        });
        layout.attach(this.alt_label, 0, 2, 1, 1);

        this.super_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.SUPER_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false,
        });
        layout.attach(this.super_label, 0, 3, 1, 1);

        // Text Input
        let scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN,
        });
        layout.attach(scroll, 1, 0, 1, 4);

        this.text = new Gtk.TextView({
            border_width: 6,
            hexpand: true,
            vexpand: true,
            visible: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
        });
        scroll.add(this.text);

        this.text.buffer.connect(
            'insert-text',
            this._onInsertText.bind(this)
        );

        this.infobar.connect('notify::reveal-child', this._onState.bind(this));
        this.plugin.bind_property('state', this.infobar, 'reveal-child', 6);

        this.show_all();
    }

    vfunc_delete_event(event) {
        this._ungrab();
        return this.hide_on_delete();
    }

    vfunc_grab_broken_event(event) {
        if (event.keyboard)
            this._ungrab();

        return false;
    }

    vfunc_key_release_event(event) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = !isAlt(keyvalLower) && (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = !isCtrl(keyvalLower) && (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = !isShift(keyvalLower) && (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = !isSuper(keyvalLower) && (realMask & Gdk.ModifierType.SUPER_MASK);

        return super.vfunc_key_release_event(event);
    }

    vfunc_key_press_event(event) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = isAlt(keyvalLower) || (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = isCtrl(keyvalLower) || (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = isShift(keyvalLower) || (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = isSuper(keyvalLower) || (realMask & Gdk.ModifierType.SUPER_MASK);

        // Wait for a real key before sending
        if (MOD_KEYS.includes(keyvalLower))
            return false;

        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab)
            keyvalLower = Gdk.KEY_Tab;

        // Put shift back if it changed the case of the key, not otherwise.
        if (keyvalLower !== event.keyval)
            realMask |= Gdk.ModifierType.SHIFT_MASK;

        // HACK: we don't want to use SysRq as a keybinding (but we do want
        // Alt+Print), so we avoid translation from Alt+Print to SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.MOD1_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower === 0)
            return false;

        debug(`keyval: ${event.keyval}, mask: ${realMask}`);

        let request = {
            alt: !!(realMask & Gdk.ModifierType.MOD1_MASK),
            ctrl: !!(realMask & Gdk.ModifierType.CONTROL_MASK),
            shift: !!(realMask & Gdk.ModifierType.SHIFT_MASK),
            super: !!(realMask & Gdk.ModifierType.SUPER_MASK),
            sendAck: true,
        };

        // specialKey
        if (ReverseKeyMap.has(event.keyval)) {
            request.specialKey = ReverseKeyMap.get(event.keyval);

        // key
        } else {
            let codePoint = Gdk.keyval_to_unicode(event.keyval);
            request.key = String.fromCodePoint(codePoint);
        }

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: request,
        });

        // Pass these key combinations rather than using the echo reply
        if (request.alt || request.ctrl || request.super)
            return super.vfunc_key_press_event(event);

        return false;
    }

    vfunc_window_state_event(event) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        if (event.new_window_state & Gdk.WindowState.FOCUSED)
            this._grab();
        else
            this._ungrab();

        return super.vfunc_window_state_event(event);
    }

    _onInsertText(buffer, location, text, len) {
        if (this._isAck)
            return;

        debug(`insert-text: ${text} (chars ${[...text].length})`);

        for (let char of [...text]) {
            if (!char)
                continue;

            // TODO: modifiers?
            this.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    alt: false,
                    ctrl: false,
                    shift: false,
                    super: false,
                    sendAck: false,
                    key: char,
                },
            });
        }
    }

    _onState(widget) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        if (this.is_active)
            this._grab();
        else
            this._ungrab();
    }

    _grab() {
        if (!this.visible || this._keyboard)
            return;

        let seat = Gdk.Display.get_default().get_default_seat();
        let status = seat.grab(
            this.get_window(),
            Gdk.SeatCapabilities.KEYBOARD,
            false,
            null,
            null,
            null
        );

        if (status !== Gdk.GrabStatus.SUCCESS) {
            logError(new Error('Grabbing keyboard failed'));
            return;
        }

        this._keyboard = seat.get_keyboard();
        this.grab_add();
        this.text.has_focus = true;
    }

    _ungrab() {
        if (this._keyboard) {
            this._keyboard.get_seat().ungrab();
            this._keyboard = null;
            this.grab_remove();
        }

        this.text.buffer.text = '';
    }
});

