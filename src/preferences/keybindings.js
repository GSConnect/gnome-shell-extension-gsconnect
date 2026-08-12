// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';


/*
 * A list of modifier keysyms we ignore
 */
const _MODIFIERS = [
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


/**
 * Response enum for ShortcutChooserDialog
 */
export const ResponseType = {
    CANCEL: Gtk.ResponseType.CANCEL,
    SET: Gtk.ResponseType.APPLY,
    UNSET: 2,
};


/**
 * A simplified version of the shortcut editor from GNOME Control Center
 */
export const ShortcutChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesShortcutEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-shortcut-editor.ui',
    Children: [
        'cancel-button', 'set-button',
        'stack', 'summary-label', 'confirm',
        'shortcut-label',
    ],
    Signals: {
        'response': {
            param_types: [GObject.TYPE_INT],
        },
    },
}, class ShortcutChooserDialog extends Adw.Dialog {

    _init(params) {
        super._init();
        Object.assign(this, params);

        // TRANSLATORS: Summary of a keyboard shortcut function
        // Example: Enter a new shortcut to change Messaging
        this.summary = _('Enter a new shortcut to change <b>%s</b>').format(
            params.summary
        );

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', this._onKeyPressed.bind(this));

        // Add the controller to the widget
        this.add_controller(keyController);

        this.cancel_button.connect('clicked', () => {
            this.response = ResponseType.CANCEL;
        });

        this.set_button.connect('clicked', () => {
            this.response = ResponseType.SET;
        });
    }

    set response(response) {
        this.emit('response', response);
        this.close();
    }

    get accelerator() {
        return this.shortcut_label.accelerator;
    }

    set accelerator(value) {
        this.shortcut_label.accelerator = value;
    }

    get summary() {
        return this.summary_label.label;
    }

    set summary(value) {
        this.summary_label.label = value;
    }

    _onKeyPressed(controller, keyval, keycode, state) {

        // Convert the key value to lowercase
        let keyvalLower = Gdk.keyval_to_lower(keyval);
        // Use the provided state, masking only the valid modifier bits
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // Ignore pure modifiers (eg. Shift, Ctrl, Alt)
        if (_MODIFIERS.includes(keyvalLower))
            return Gdk.EVENT_STOP;


        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab)
            keyvalLower = Gdk.KEY_Tab;


        // Handle Shift (uppercase letters)
        if (keyvalLower !== keyval)
            realMask |= Gdk.ModifierType.SHIFT_MASK;


        // Prevent Alt+Print from being interpreted as SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req &&
            (realMask & Gdk.ModifierType.MOD1_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;


        // Esc cancels editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.response = ResponseType.CANCEL;
            return Gdk.EVENT_STOP;
        }

        // Backspace disables the current shortcut
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this.response = ResponseType.UNSET;
            return Gdk.EVENT_STOP;
        }

        // Ignore CapsLock
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        // If we have a valid key and modifier
        if (keyvalLower !== 0 && realMask !== 0) {

            // Set the accelerator and update the label
            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);

            this.cancel_button.visible = true;
            this.stack.visible_child = this.confirm;

            this._check();
        }

        return Gdk.EVENT_STOP;
    }

    _check() {
        try {
            const message = this.checkAccelerator?.(this.accelerator) || '';

            this.confirm.description = message;
            this.set_button.visible = true;
            this.set_button.sensitive = message === '';
        } catch (e) {
            logError(e);
            this.response = ResponseType.CANCEL;
        }
    }
});


/**
 * Show a dialog to get a keyboard shortcut from a user.
 *
 * @param {string} summary - A description of the keybinding's function
 * @param {string} accelerator - An accelerator as taken by Gtk.ShortcutLabel
 * @param {?function(string): ?string} checkAccelerator - An accelerator check
 * @returns {string} An accelerator or %null if it should be unset.
 */
export async function getAccelerator(summary, accelerator = null, checkAccelerator = null) {
    try {
        const dialog = new ShortcutChooserDialog({
            summary: summary,
            accelerator: accelerator,
            checkAccelerator: checkAccelerator,
        });
        accelerator = await new Promise((resolve, reject) => {
            dialog.connect('response', (dialog, response) => {
                switch (response) {
                    case ResponseType.SET:
                        accelerator = dialog.accelerator;
                        break;

                    case ResponseType.UNSET:
                        accelerator = null;
                        break;

                    case ResponseType.CANCEL:
                        // leave the accelerator as passed in
                        break;
                }
                resolve(accelerator);
            });

            dialog.present(Gio.Application.get_default().get_active_window());
        });

        return accelerator;
    } catch (e) {
        logError(e);
        return accelerator;
    }
}
