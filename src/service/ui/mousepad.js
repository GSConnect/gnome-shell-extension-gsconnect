// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

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

var RightClickGesture = GObject.registerClass({
    GTypeName: 'RightClickGesture',
    Signals: {
        'two-finger-tap': {},
    },
}, class RightClickGesture extends Gtk.Gesture {
    _init() {
        super._init({n_points: 2});

        this.connect('end', (gesture, sequence) => {
            const enabled = this.get_point(sequence)[0];
            if (enabled)
                this.emit('two-finger-tap');
        });
    }
});

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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/mousepad-input-dialog.ui',
    Children: [
        'infobar', 'mouse-left-button', 'mouse-middle-button', 'mouse-right-button',
        'touchpad-zone', 'shift-label', 'ctrl-label', 'alt-label', 'super-label',
        'entry', 'title-widget',
    ],
}, class InputDialog extends Adw.ApplicationWindow {

    _init(params) {
        super._init(params);

        this.title_widget.subtitle = this.device.name;
        this.set_hide_on_close(true);

        // TRANSLATORS: Displayed when the remote keyboard is not ready to accept input
        this.infobar.title = _('Remote keyboard on %s is not active').format(this.device.name);
        this.plugin.bind_property(
            'state',
            this.infobar,
            'revealed',
            GObject.BindingFlags.INVERT_BOOLEAN
        );
        this.touchpad_zone.label = _('Touchpad.\nDrag on this area to move mouse cursor.\nPress long to drag to drag mouse cursor.\n\nSimple click will be sent to paired device.\nLeft, middle, right button, and wheel scrolls.');

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', this._onKeyPress.bind(this));
        keyController.connect('key-released', this._onKeyRelease.bind(this));
        this.entry.add_controller(keyController);

        // Mouse Pad
        this._resetTouchpadMotion();
        this.touchpad_motion_timeout_id = 0;
        this.touchpad_holding = false;

        const clickController = new Gtk.GestureClick();
        clickController.connect('pressed', this._onTouchpadLongPressPressed.bind(this));
        clickController.connect('stopped', this._onTouchpadLongPressPressed.bind(this));
        clickController.connect('released', this._onTouchpadLongPressEnd.bind(this));


        // Controller per il movimento
        const motionController = new Gtk.EventControllerMotion();
        motionController.connect('enter', this._onTouchpadDragBegin.bind(this));
        motionController.connect('motion', this._onTouchpadDragUpdate.bind(this));
        motionController.connect('leave', this._onTouchpadDragEnd.bind(this));

        const scrollController = new Gtk.EventControllerScroll({flags: Gtk.EventControllerScrollFlags.VERTICAL});
        scrollController.connect('scroll', this._onScroll.bind(this));

        const rightClickGesture = new RightClickGesture();
        rightClickGesture.connect('two-finger-tap', () => {
            this._onMouseRightButtonClicked();
        });
        this.touchpad_zone.add_controller(scrollController);
        this.touchpad_zone.add_controller(rightClickGesture);
        this.touchpad_zone.add_controller(motionController);
        this.touchpad_zone.add_controller(clickController);
    }

    _onKeyRelease(controller, keyval, keycode, state) {
        if (!this.plugin.state) {
            debug('Ignoring remote keyboard state');
            return false;
        }

        const keyvalLower = Gdk.keyval_to_lower(keyval);
        const realMask = state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = !isAlt(keyvalLower) && (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = !isCtrl(keyvalLower) && (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = !isShift(keyvalLower) && (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = !isSuper(keyvalLower) && (realMask & Gdk.ModifierType.SUPER_MASK);

        return false;
    }

    _onKeyPress(controller, keyval, keycode, state) {
        if (!this.plugin.state) {
            debug('Ignoring remote keyboard state');
            return false;
        }

        let keyvalLower = Gdk.keyval_to_lower(keyval);
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        this.alt_label.sensitive = isAlt(keyvalLower) || (realMask & Gdk.ModifierType.ALT_MASK);
        this.ctrl_label.sensitive = isCtrl(keyvalLower) || (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = isShift(keyvalLower) || (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = isSuper(keyvalLower) || (realMask & Gdk.ModifierType.SUPER_MASK);

        if (MOD_KEYS.includes(keyvalLower))
            return false;

        if (keyvalLower === Gdk.KEY_ISO_Left_Tab)
            keyvalLower = Gdk.KEY_Tab;

        if (keyvalLower !== keyval)
            realMask |= Gdk.ModifierType.SHIFT_MASK;

        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.ALT_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;

        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower === 0)
            return false;

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
        } else {
            // key
            const codePoint = Gdk.keyval_to_unicode(keyval);
            request.key = String.fromCodePoint(codePoint);
        }

        const pack = {
            type: 'kdeconnect.mousepad.request',
            body: request,
        };
        this.device.sendPacket(pack);

        if (request.alt || request.ctrl || request.super)
            return true;

        return Gdk.EVENT_STOP;
    }

    _onScroll(controller, dx, dy) {
        if (dx === 0 && dy === 0)
            return true;

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                scroll: true,
                dx: dx * 200,
                dy: dy * 200,
            },
        });

        return true;
    }

    _resetTouchpadMotion() {
        this.touchpad_motion_x = 0;
        this.touchpad_motion_y = 0;
    }

    _onMouseLeftButtonClicked(button) {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                singleclick: true,
            },
        });
    }

    _onMouseMiddleButtonClicked(button) {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                middleclick: true,
            },
        });
    }

    _onMouseRightButtonClicked(button) {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                rightclick: true,
            },
        });
    }

    _onTouchpadDragBegin(gesture, offset_x, offset_y) {
        this.touchpad_motion_prev_x = offset_x;
        this.touchpad_motion_prev_y = offset_y;
        this.touchpad_motion_timeout_id =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10,
                this._onTouchpadMotionTimeout.bind(this));
    }

    _onTouchpadDragUpdate(gesture, offset_x, offset_y) {
        this.touchpad_motion_x = offset_x;
        this.touchpad_motion_y = offset_y;
    }

    _onTouchpadDragEnd(gesture, offset_x, offset_y) {
        GLib.Source.remove(this.touchpad_motion_timeout_id);
        this.touchpad_motion_timeout_id = 0;
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
