// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';


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


export const InputDialog = GObject.registerClass({
    GTypeName: 'GSConnectMousepadInputDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The mousepad plugin associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
}, class InputDialog extends Adw.Window {

    _init(params) {
        super._init({
            default_width: 480,
            default_height: 560,
            application: Gio.Application.get_default(),
            device: params.device,
            plugin: params.plugin,
            title: _('Remote Input'),
        });

        this._buildLayout();

        // TRANSLATORS: Displayed when the remote keyboard is not ready to accept input
        this._banner.title = _('Remote keyboard on %s is not active').format(this.device.name);

        // Text Input
        this.entry.buffer.connect(
            'insert-text',
            this._onInsertText.bind(this)
        );

        this.plugin.bind_property(
            'state',
            this._banner,
            'revealed',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Mouse Pad
        this._resetTouchpadMotion();
        this.touchpad_motion_timeout_id = 0;
        this.touchpad_holding = false;

        // Keyboard
        const keys = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keys.connect('key-pressed', this._onKeyPressed.bind(this));
        keys.connect('key-released', this._onKeyReleased.bind(this));
        this.add_controller(keys);

        // Scroll Input
        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
        });
        scroll.connect('scroll', this._onScroll.bind(this));
        this.add_controller(scroll);

        // Grab/release system shortcuts with the focus
        this.connect('notify::is-active', this._onState.bind(this));
        this.connect('close-request', this._onCloseRequest.bind(this));
    }

    _buildLayout() {
        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        toolbar.add_top_bar(new Adw.HeaderBar({
            title_widget: new Adw.WindowTitle({
                title: _('Remote Input'),
                subtitle: this.device.name,
            }),
        }));

        this._banner = new Adw.Banner({
            button_label: _('Help'),
        });
        this._banner.connect('button-clicked', () => {
            Gio.AppInfo.launch_default_for_uri_async(
                'https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Help#remote-keyboard-not-active',
                null, null, null
            );
        });
        toolbar.add_top_bar(this._banner);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        toolbar.set_content(box);

        // Touchpad
        this.touchpad = new Gtk.Box({
            vexpand: true,
            margin_top: 12,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 6,
        });
        this.touchpad.add_css_class('card');
        this.touchpad.append(new Gtk.Label({
            label: _('Touchpad.\nDrag on this area to move mouse cursor.\nPress long to drag to drag mouse cursor.\n\nSimple click will be sent to paired device.\nLeft, middle, right button, and wheel scrolls.'),
            justify: Gtk.Justification.CENTER,
            hexpand: true,
            halign: Gtk.Align.FILL,
            wrap: true,
        }));
        box.append(this.touchpad);

        this.touchpad_drag = new Gtk.GestureDrag();
        this.touchpad_drag.connect('drag-begin', this._onTouchpadDragBegin.bind(this));
        this.touchpad_drag.connect('drag-update', this._onTouchpadDragUpdate.bind(this));
        this.touchpad_drag.connect('drag-end', this._onTouchpadDragEnd.bind(this));
        this.touchpad.add_controller(this.touchpad_drag);

        this.touchpad_long_press = new Gtk.GestureLongPress({button: 0});
        this.touchpad_long_press.connect('cancelled', this._onTouchpadLongPressCancelled.bind(this));
        this.touchpad_long_press.connect('pressed', this._onTouchpadLongPressPressed.bind(this));
        this.touchpad_long_press.connect('end', this._onTouchpadLongPressEnd.bind(this));
        this.touchpad.add_controller(this.touchpad_long_press);

        // Mouse buttons
        const buttons = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            margin_bottom: 6,
        });
        buttons.add_css_class('linked');
        box.append(buttons);

        for (const [icon, key] of [
            ['mouse-left-button-symbolic', 'singleclick'],
            ['mouse-with-smaller-scrollwheel-symbolic', 'middleclick'],
            ['mouse-right-button-symbolic', 'rightclick'],
        ]) {
            const button = new Gtk.Button({icon_name: icon});
            button.connect('clicked', () => {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.request',
                    body: {[key]: true},
                });
            });
            buttons.append(button);
        }

        // Modifier state
        const modifiers = new Gtk.Box({
            spacing: 12,
            halign: Gtk.Align.CENTER,
            margin_bottom: 6,
        });
        box.append(modifiers);

        for (const [name, accelerator] of [
            ['shift_label', '<Shift>'],
            ['ctrl_label', '<Control>'],
            ['alt_label', '<Alt>'],
            ['super_label', '<Super>'],
        ]) {
            this[name] = new Gtk.ShortcutLabel({accelerator, sensitive: false});
            modifiers.append(this[name]);
        }

        // Text entry
        this.entry = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 6,
            bottom_margin: 6,
            left_margin: 6,
            right_margin: 6,
        });
        const frame = new Gtk.ScrolledWindow({
            child: this.entry,
            height_request: 80,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
        });
        frame.add_css_class('card');
        box.append(frame);
    }

    _onCloseRequest() {
        this._ungrab();
        this.set_visible(false);

        return true;
    }

    _onKeyReleased(controller, keyval, keycode, state) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        const keyvalLower = Gdk.keyval_to_lower(keyval);
        const realMask = state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = !isAlt(keyvalLower) &&
            !!(realMask & Gdk.ModifierType.ALT_MASK);

        this.ctrl_label.sensitive = !isCtrl(keyvalLower) &&
            !!(realMask & Gdk.ModifierType.CONTROL_MASK);

        this.shift_label.sensitive = !isShift(keyvalLower) &&
            !!(realMask & Gdk.ModifierType.SHIFT_MASK);

        this.super_label.sensitive = !isSuper(keyvalLower) &&
            !!(realMask & Gdk.ModifierType.SUPER_MASK);
    }

    _onKeyPressed(controller, keyval, keycode, state) {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        let keyvalLower = Gdk.keyval_to_lower(keyval);
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = isAlt(keyvalLower) ||
            !!(realMask & Gdk.ModifierType.ALT_MASK);

        this.ctrl_label.sensitive = isCtrl(keyvalLower) ||
            !!(realMask & Gdk.ModifierType.CONTROL_MASK);

        this.shift_label.sensitive = isShift(keyvalLower) ||
            !!(realMask & Gdk.ModifierType.SHIFT_MASK);

        this.super_label.sensitive = isSuper(keyvalLower) ||
            !!(realMask & Gdk.ModifierType.SUPER_MASK);

        // Wait for a real key before sending
        if (MOD_KEYS.includes(keyvalLower))
            return Gdk.EVENT_PROPAGATE;

        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab)
            keyvalLower = Gdk.KEY_Tab;

        // Put shift back if it changed the case of the key, not otherwise.
        if (keyvalLower !== keyval)
            realMask |= Gdk.ModifierType.SHIFT_MASK;

        // HACK: we don't want to use SysRq as a keybinding (but we do want
        // Alt+Print), so we avoid translation from Alt+Print to SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.ALT_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower === 0)
            return Gdk.EVENT_PROPAGATE;

        debug(`keyval: ${keyval}, mask: ${realMask}`);

        const request = {
            alt: !!(realMask & Gdk.ModifierType.ALT_MASK),
            ctrl: !!(realMask & Gdk.ModifierType.CONTROL_MASK),
            shift: !!(realMask & Gdk.ModifierType.SHIFT_MASK),
            super: !!(realMask & Gdk.ModifierType.SUPER_MASK),
            sendAck: true,
        };

        // specialKey
        if (ReverseKeyMap.has(keyval)) {
            request.specialKey = ReverseKeyMap.get(keyval);

        // key
        } else {
            const codePoint = Gdk.keyval_to_unicode(keyval);
            request.key = String.fromCodePoint(codePoint);
        }

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: request,
        });

        // Pass these key combinations rather than using the echo reply
        if (request.alt || request.ctrl || request.super)
            return Gdk.EVENT_PROPAGATE;

        return Gdk.EVENT_STOP;
    }

    _onScroll(controller, dx, dy) {
        if (dx === 0 && dy === 0)
            return Gdk.EVENT_STOP;

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                scroll: true,
                dx: dx * 200,
                dy: dy * 200,
            },
        });

        return Gdk.EVENT_STOP;
    }

    _onInsertText(buffer, location, text, len) {
        if (this._isAck)
            return;

        debug(`insert-text: ${text} (chars ${[...text].length})`);

        for (const char of [...text]) {
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

    _onState() {
        if (!this.plugin.state)
            debug('ignoring remote keyboard state');

        if (this.is_active)
            this._grab();
        else
            this._ungrab();
    }

    /*
     * Ask the compositor to deliver system shortcuts (eg. Super, Alt+Tab) to
     * this window while it is focused, so they can be sent to the device.
     */
    _grab() {
        const surface = this.get_surface();

        if (!this.visible || this._keyboard || !surface?.inhibit_system_shortcuts)
            return;

        surface.inhibit_system_shortcuts(null);
        this._keyboard = surface;
        this.set_focus(this.entry);
    }

    _ungrab() {
        if (this._keyboard) {
            this._keyboard.restore_system_shortcuts();
            this._keyboard = null;
        }

        this.entry.buffer.text = '';
    }

    _resetTouchpadMotion() {
        this.touchpad_motion_prev_x = 0;
        this.touchpad_motion_prev_y = 0;
        this.touchpad_motion_x = 0;
        this.touchpad_motion_y = 0;
    }

    _onTouchpadDragBegin(gesture) {
        this._resetTouchpadMotion();

        this.touchpad_motion_timeout_id =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10,
                this._onTouchpadMotionTimeout.bind(this));
    }

    _onTouchpadDragUpdate(gesture, offset_x, offset_y) {
        this.touchpad_motion_x = offset_x;
        this.touchpad_motion_y = offset_y;
    }

    _onTouchpadDragEnd(gesture) {
        this._resetTouchpadMotion();

        if (this.touchpad_motion_timeout_id > 0) {
            GLib.Source.remove(this.touchpad_motion_timeout_id);
            this.touchpad_motion_timeout_id = 0;
        }
    }

    _onTouchpadLongPressCancelled(gesture) {
        const gesture_button = gesture.get_current_button();

        // Check user dragged less than certain distances.
        const is_click =
            (Math.abs(this.touchpad_motion_x) < 4) &&
            (Math.abs(this.touchpad_motion_y) < 4);

        if (is_click) {
            const click_body = {};
            switch (gesture_button) {
                case 1:
                    click_body.singleclick = true;
                    break;

                case 2:
                    click_body.middleclick = true;
                    break;

                case 3:
                    click_body.rightclick = true;
                    break;

                default:
                    return;
            }

            this.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: click_body,
            });
        }
    }

    _onTouchpadLongPressPressed(gesture) {
        const gesture_button = gesture.get_current_button();

        if (gesture_button !== 1) {
            debug('Long press on other type of buttons are not handled.');
        } else {
            this.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    singlehold: true,
                },
            });
            this.touchpad_holding = true;
        }
    }

    _onTouchpadLongPressEnd(gesture) {
        if (this.touchpad_holding) {
            this.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    singlerelease: true,
                },
            });
            this.touchpad_holding = false;
        }
    }

    _onTouchpadMotionTimeout() {
        const diff_x = this.touchpad_motion_x - this.touchpad_motion_prev_x;
        const diff_y = this.touchpad_motion_y - this.touchpad_motion_prev_y;

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                dx: diff_x,
                dy: diff_y,
            },
        });

        this.touchpad_motion_prev_x = this.touchpad_motion_x;
        this.touchpad_motion_prev_y = this.touchpad_motion_y;
        return true;
    }
});
