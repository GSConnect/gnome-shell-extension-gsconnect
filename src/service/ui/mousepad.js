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


export const InputWindow = GObject.registerClass({
    GTypeName: 'GSConnectMousepadInputWindow',
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
        'infobar','mouse-left-button', 'mouse-middle-button', 'mouse-right-button',
        'touchpad-zone', 'shift-label', 'ctrl-label', 'alt-label', 'super-label', 
        'entry', 'title-widget'
    ],
}, class InputWindow extends Adw.ApplicationWindow {

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
        this.touchpad_zone.label = _('Touchpad.\nDrag on this area to move mouse cursor.\nPress long to drag to drag mouse cursor.\n\nSimple click will be sent to paired device.\nLeft, middle, right button, and wheel scrolls.')
        // Text Input
        this.entry.buffer.connect(
            'insert-text',
            this._onInsertText.bind(this)
        );
        let keyController = new Gtk.EventControllerKey(); 
        keyController.connect("key-pressed", this._onKeyPress.bind(this));
        keyController.connect("key-released", this._onKeyRelease.bind(this));
        this.entry.add_controller(keyController);
        
        // Mouse Pad
        this._resetTouchpadMotion();
        this.touchpad_motion_timeout_id = 0;
        this.touchpad_holding = false;

        let clickGesture = Gtk.GestureClick.new();
        clickGesture.connect("pressed", this._onTouchpadLongPressPressed.bind(this));
        clickGesture.connect("stopped", this._onTouchpadLongPressPressed.bind(this));
        clickGesture.connect("released", this._onTouchpadLongPressEnd.bind(this));
        
        // Controller per il movimento
        let motionController = Gtk.EventControllerMotion.new();
        motionController.connect("enter", this._onTouchpadDragBegin.bind(this));
        motionController.connect("motion", this._onTouchpadDragUpdate.bind(this));
        motionController.connect("leave", this._onTouchpadDragEnd.bind(this));
        
        let scrollController = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.VERTICAL);
        scrollController.connect("scroll", this._onScroll.bind(this));

        this.touchpad_zone.add_controller(scrollController);
        this.touchpad_zone.add_controller(motionController);
        this.touchpad_zone.add_controller(clickGesture);
    }
   
    _onKeyRelease(controller, keyval, keycode, state) {
        if (!this.plugin.state) {
            debug('Ignoring remote keyboard state');
            return false;    
        }
    
        const keyvalLower = Gdk.keyval_to_lower(keyval); // keyval è fornito direttamente dal segnale
        const realMask = state & Gtk.accelerator_get_default_mod_mask();
    
        // Aggiorna lo stato dei label come nell'implementazione originale
        this.alt_label.sensitive = !isAlt(keyvalLower) && (realMask & Gdk.ModifierType.MOD1_MASK);
        this.ctrl_label.sensitive = !isCtrl(keyvalLower) && (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = !isShift(keyvalLower) && (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = !isSuper(keyvalLower) && (realMask & Gdk.ModifierType.SUPER_MASK);
    
        return false; // Ritorna false per permettere ad altri gestori di trattare l'evento
    }

    _onKeyPress(controller, keyval, keycode, state) {
        if (!this.plugin.state) {
            debug('Ignoring remote keyboard state');
            return false;
        }
        
        const keyvalLower = Gdk.keyval_to_lower(keyval); // keyval è fornito direttamente dal segnale
        // 1) maschera dei modificatori correnti
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // Aggiorna lo stato dei label come nell'implementazione originale
        this.alt_label.sensitive = isAlt(keyvalLower) || (realMask & Gdk.ModifierType.ALT_MASK);
        this.ctrl_label.sensitive = isCtrl(keyvalLower) || (realMask & Gdk.ModifierType.CONTROL_MASK);
        this.shift_label.sensitive = isShift(keyvalLower) || (realMask & Gdk.ModifierType.SHIFT_MASK);
        this.super_label.sensitive = isSuper(keyvalLower) || (realMask & Gdk.ModifierType.SUPER_MASK);

        // Aspetta un tasto reale prima di inviare
        if (MOD_KEYS.includes(keyvalLower)) return false;

        // Normalizza Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) keyvalLower = Gdk.KEY_Tab;

        // Aggiungi Shift se ha cambiato il caso del tasto
        if (keyvalLower !== keyval) realMask |= Gdk.ModifierType.SHIFT_MASK;

        // Gestione speciale per Alt+Print
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.ALT_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;

        // Ignora il CapsLock come modificatore
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower === 0) return false;

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

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: request,
        });

        // Passa queste combinazioni di tasti
        if (request.alt || request.ctrl || request.super) return true;

        return false;
    }

    _onScroll(controller, dx, dy) {
        // Ignora scorrimenti nulli
        if (dx === 0 && dy === 0) return true;
    
        // Invia il pacchetto al dispositivo
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {
                scroll: true,
                dx: dx * 200,
                dy: dy * 200,
            },
        });
    
        return true; // Evento gestito
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

    _resetTouchpadMotion() {
        this.touchpad_motion_prev_x = 0;
        this.touchpad_motion_prev_y = 0;
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
        this._resetTouchpadMotion();
        this.touchpad_motion_timeout_id =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10,
                this._onTouchpadMotionTimeout.bind(this));
    }

    _onTouchpadDragUpdate(gesture, offset_x, offset_y) {
        this.touchpad_motion_x = offset_x;
        this.touchpad_motion_y = offset_y;
    }

    _onTouchpadDragEnd(gesture, offset_x, offset_y) {
        this._resetTouchpadMotion();
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

    _onTouchpadLongPressPressed(gesture, offset_x, offset_y) {
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

    _onTouchpadLongPressEnd(gesture, x, y) {
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
