'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


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


var InputDialog = GObject.registerClass({
    GTypeName: 'GSConnectMousepadInputDialog',
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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/mousepad-input-dialog.ui',
    Children: [
        'infobar', 'infobar-label',
        'shift-label', 'ctrl-label', 'alt-label', 'super-label', 'entry',
    ],
}, class InputDialog extends Gtk.Dialog {

    _init(params) {
        super._init(Object.assign({
            use_header_bar: true,
        }, params));

        let headerbar = this.get_titlebar();
        headerbar.title = _('Keyboard');
        headerbar.subtitle = this.device.name;

        // Main Box
        let content = this.get_content_area();
        content.border_width = 0;

        // TRANSLATORS: Displayed when the remote keyboard is not ready to accept input
        this.infobar_label.label = _('Remote keyboard on %s is not active').format(this.device.name);

        // Text Input
        this.entry.buffer.connect(
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
        this.entry.has_focus = true;
    }

    _ungrab() {
        if (this._keyboard) {
            this._keyboard.get_seat().ungrab();
            this._keyboard = null;
            this.grab_remove();
        }

        this.entry.buffer.text = '';
    }
});
