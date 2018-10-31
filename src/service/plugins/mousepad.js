'use strict';

const Atspi = imports.gi.Atspi;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Mousepad'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
    incomingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate'
    ],
    outgoingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate'
    ],
    actions: {
        keyboard: {
            label: _('Keyboard'),
            icon_name: 'input-keyboard-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.mousepad.echo', 'kdeconnect.mousepad.keyboardstate'],
            outgoing: ['kdeconnect.mousepad.request']
        }
    }
};


/**
 * A map of "KDE Connect" keyvals to Gdk
 */
const KeyMap = new Map([
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
    [32, Gdk.KEY_F12]
]);


/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 *
 * TODO: support outgoing mouse/keyboard events
 *       remove Caribou
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
        'share-control': GObject.ParamSpec.boolean(
            'share-control',
            'Share Control',
            'Share control of mouse & keyboard',
            GObject.ParamFlags.READWRITE,
            false
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'mousepad');

        // See: https://wiki.gnome.org/Accessibility/Wayland#Bugs.2FIssues_We_Must_Address
        if (GLib.getenv('XDG_SESSION_TYPE') === 'wayland') {
            this.destroy();
            let e = new Error();
            e.name = 'WaylandNotSupported';
            throw e;
        }

        // Atspi.init() return 2 on fail, but still marks itself as inited. We
        // uninit before throwing an error otherwise any future call to init()
        // will appear successful and other calls will cause GSConnect to exit.
        // See: https://gitlab.gnome.org/GNOME/at-spi2-core/blob/master/atspi/atspi-misc.c
        if (Atspi.init() === 2) {
            Atspi.exit();
            this.destroy();

            let e = new Error();
            e.name = 'WaylandNotSupported';
            throw e;
        }

        try {
            this._display = Gdk.Display.get_default();
            this._seat = this._display.get_default_seat();
            this._pointer = this._seat.get_pointer();
        } catch (e) {
            e.name = 'DisplayError';
            throw e;
        }

        // Try import Caribou
        // FIXME: deprecated
        try {
            const Caribou = imports.gi.Caribou;
            this._vkbd = Caribou.DisplayAdapter.get_default();
        } catch (e) {
            logWarning(e);
        }

        this.settings.bind(
            'share-control',
            this,
            'share-control',
            Gio.SettingsBindFlags.GET
        );

        this._state = false;
        this._stateId = 0;
    }

    connected() {
        super.connected();
        this.sendState();
    }

    disconnected() {
        super.disconnected();

        this._state = false;
        this._stateId = 0;
        this.notify('state');
    }

    get state() {
        return (this._state);
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.mousepad.request':
                if (this.share_control) {
                    this._handleInput(packet.body);
                }
                break;

            case 'kdeconnect.mousepad.echo':
                this._handleEcho(packet.body);
                break;

            case 'kdeconnect.mousepad.keyboardstate':
                this._handleState(packet);
                break;
        }
    }

    _handleInput(input) {
        // These are ordered, as much as possible, to create the shortest code
        // path for high-frequency, low-latency events (eg. mouse movement)
        switch (true) {
            case input.hasOwnProperty('scroll'):
                if (input.dy < 0) {
                    this.clickPointer(5);
                } else if (input.dy > 0) {
                    this.clickPointer(4);
                }
                break;

            case (input.hasOwnProperty('dx') && input.hasOwnProperty('dy')):
                this.movePointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('key') || input.hasOwnProperty('specialKey')):
                if (this._vkbd ) {
                    // Set Gdk.ModifierType
                    let mask = 0;

                    if (input.hasOwnProperty('ctrl') && input.ctrl) {
                        mask |= Gdk.ModifierType.CONTROL_MASK;
                    }
                    if (input.hasOwnProperty('shift') && input.shift) {
                        mask |= Gdk.ModifierType.SHIFT_MASK;
                    }
                    if (input.hasOwnProperty('alt') && input.alt) {
                        mask |= Gdk.ModifierType.MOD1_MASK;
                    }
                    if (input.hasOwnProperty('super') && input.super) {
                        mask |= Gdk.ModifierType.MOD4_MASK;
                    }

                    // Transform key to keysym
                    let keysym;

                    if (input.key && input.key !== '\u0000') {
                        keysym = Gdk.unicode_to_keyval(input.key.codePointAt(0));
                    } else if (input.specialKey && KeyMap.has(input.specialKey)) {
                        keysym = KeyMap.get(input.specialKey);
                    }

                    if (keysym) {
                        this.pressKeySym(keysym, mask);
                    }
                } else {
                    // This is sometimes sent in advance of a specialKey packet
                    if (input.key && input.key !== '\u0000') {
                        this.pressKey(input.key);
                    } else if (input.specialKey) {
                        this.pressSpecialKey(input.specialKey);
                    }
                }

                this.sendEcho(input);
                break;

            case input.hasOwnProperty('singleclick'):
                this.clickPointer(1);
                break;

            case input.hasOwnProperty('doubleclick'):
                this.doubleclickPointer(1);
                break;

            case input.hasOwnProperty('middleclick'):
                this.clickPointer(2);
                break;

            case input.hasOwnProperty('rightclick'):
                this.clickPointer(3);
                break;

            case input.hasOwnProperty('singlehold'):
                this.pressPointer(1);
                break;

            // This is not used, hold is released with a regular click instead
            case input.hasOwnProperty('singlerelease'):
                this.releasePointer(1);
                break;
        }
    }

    clickPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            let monitor = this._display.get_monitor_at_point(x, y);
            let scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}c`);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    doubleclickPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            let monitor = this._display.get_monitor_at_point(x, y);
            let scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}d`);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    movePointer(dx, dy) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            let monitor = this._display.get_monitor_at_point(x, y);
            let scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * dx, scale * dy, 'rel');
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    pressPointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            let monitor = this._display.get_monitor_at_point(x, y);
            let scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}p`);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    releasePointer(button) {
        try {
            let [screen, x, y] = this._pointer.get_position();
            let monitor = this._display.get_monitor_at_point(x, y);
            let scale = monitor.get_scale_factor();
            Atspi.generate_mouse_event(scale * x, scale * y, `b${button}r`);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    pressKey(key) {
        try {
            Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING);
        } catch (e) {
            logError(e, this.device.name);
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
            logError(e, this.device.name);
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
            logError(e, this.device.name);
        }
    }

    _handleEcho(input) {
        if (!this._dialog || !this._dialog.visible) {
            return;
        }

        if (input.alt || input.ctrl || input.super) {
            return;
        }

        if (input.key) {
            this._dialog.text.buffer.text += input.key;
        } else if (KeyMap.get(input.specialKey) === Gdk.KEY_BackSpace) {
            this._dialog.text.emit('backspace');
        }
    }

    /**
     * Send an echo/ACK of @input, if requested
     *
     * @param {object} input - 'body' of a 'kdeconnect.mousepad.request' packet
     */
    sendEcho(input) {
        if (input.sendAck) {
            delete input.sendAck;
            input.isAck = true;

            this.device.sendPacket({
                type: 'kdeconnect.mousepad.echo',
                body: input
            });
        }
    }

    _handleState(packet) {
        // HACK: ensure we don't get packets out of order
        if (packet.id > this._stateId) {
            this._state = packet.body.state;
            this._stateId = packet.id;
            this.notify('state');
        }
    }

    /**
     * Send the local keyboard state
     *
     * @param {boolean} state - Whether we're ready to accept input
     */
    sendState() {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.keyboardstate',
            body: {
                state: this.share_control
            }
        });
    }

    /**
     * Open the Keyboard Input dialog
     */
    keyboard() {
        if (!this._dialog) {
            this._dialog = new KeyboardInputDialog({
                device: this.device,
                plugin: this
            });
        }

        this._dialog.present();
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
    [Gdk.KEY_F12, 32]
]);


/**
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
    Gdk.KEY_Super_R
];


/**
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
        )
    }
}, class KeyboardInputDialog extends Gtk.Dialog {

    _init(params) {
        super._init(Object.assign({
            use_header_bar: true,
            default_width: 480,
            window_position: Gtk.WindowPosition.CENTER
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

        let infolabel = new Gtk.Label({label: _('Keyboard not ready')});
        bar.get_content_area().add(infolabel);

        // Content
        let layout = new Gtk.Grid({
            column_spacing: 6,
            margin: 6
        });
        content.add(layout);

        // Modifier Buttons
        this.shift_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.SHIFT_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false
        });
        layout.attach(this.shift_label, 0, 0, 1, 1);

        this.ctrl_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.CONTROL_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false
        });
        layout.attach(this.ctrl_label, 0, 1, 1, 1);

        this.alt_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.MOD1_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false
        });
        layout.attach(this.alt_label, 0, 2, 1, 1);

        this.super_label = new Gtk.ShortcutLabel({
            accelerator: Gtk.accelerator_name(0, Gdk.ModifierType.SUPER_MASK),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            sensitive: false
        });
        layout.attach(this.super_label, 0, 3, 1, 1);

        // Text Input
        let scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        layout.attach(scroll, 1, 0, 1, 4);

        this.text = new Gtk.TextView({
            border_width: 6,
            hexpand: true,
            vexpand: true,
            visible: true
        });
        scroll.add(this.text);

        this.infobar.connect('notify::reveal-child', this._onState.bind(this));
        this.plugin.bind_property('state', this.infobar, 'reveal-child', 6);

        this.show_all();
    }

    vfunc_delete_event(event) {
        this._ungrab();
        return this.hide_on_delete();
    }

    vfunc_key_release_event(event) {
        if (!this.plugin.state) {
            return true;
        }

        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = !isAlt(keyvalLower) && (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = !isCtrl(keyvalLower) && (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = !isShift(keyvalLower) && (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = !isSuper(keyvalLower) && (realMask & Gdk.ModifierType.SUPER_MASK);

        return super.vfunc_key_release_event(event);
    }

    vfunc_key_press_event(event) {
        if (!this.plugin.state) {
            return true;
        }

        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = isAlt(keyvalLower) || (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = isCtrl(keyvalLower) || (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = isShift(keyvalLower) || (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = isSuper(keyvalLower) || (realMask & Gdk.ModifierType.SUPER_MASK);

        // Wait for a real key before sending
        if (MOD_KEYS.includes(keyvalLower)) {
            return false;
        }

        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }

        // Put shift back if it changed the case of the key, not otherwise.
        if (keyvalLower !== event.keyval) {
            realMask |= Gdk.ModifierType.SHIFT_MASK;
        }

        // HACK: we don't want to use SysRq as a keybinding (but we do want
        // Alt+Print), so we avoid translation from Alt+Print to SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.MOD1_MASK) !== 0) {
            keyvalLower = Gdk.KEY_Print;
        }

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower !== 0) {
            debug(`keyval: ${event.keyval}, mask: ${realMask}`);

            let request = {
                alt: !!(realMask & Gdk.ModifierType.MOD1_MASK),
                ctrl: !!(realMask & Gdk.ModifierType.CONTROL_MASK),
                shift: !!(realMask & Gdk.ModifierType.SHIFT_MASK),
                super: !!(realMask & Gdk.ModifierType.SUPER_MASK),
                sendAck: true
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
                body: request
            });

            // Pass these key combinations rather than using the echo reply
            if (request.alt || request.ctrl || request.super) {
                return super.vfunc_key_press_event(event);
            }
        }

        return false;
    }

    vfunc_window_state_event(event) {
        if (this.plugin.state && !!(event.new_window_state & Gdk.WindowState.FOCUSED)) {
            this._grab();
        } else {
            this._ungrab();
        }

        return super.vfunc_window_state_event(event);
    }

    _onState(widget) {
        if (this.plugin.state && this.is_active) {
            this._grab();
        } else {
            this._ungrab();
        }
    }

    _grab() {
        if (!this.visible || this._device) {
            return;
        }

        debug('acquiring grab');

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
            logWarning('Grabbing keyboard failed');
            return;
        }

        this._device = seat.get_keyboard();
        this.grab_add();
        this.text.has_focus = true;
    }

    _ungrab() {
        if (this._device) {
            debug('releasing grab');

            this._device.get_seat().ungrab();
            this._device = null;
            this.grab_remove();
        }

        this.text.buffer.text = '';
    }
});

