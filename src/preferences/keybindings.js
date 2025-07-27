// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';


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
        'stack', 'summary-label',
        'shortcut-label',
    ],
}, class ShortcutChooserDialog extends Gtk.Dialog {

    _init(params) {
        super._init({
            transient_for: Gio.Application.get_default().get_active_window(),
            use_header_bar: true,
        });

        this._seat = Gdk.Display.get_default().get_default_seat();

        // Current accelerator or %null
        this.accelerator = params.accelerator;

        // TRANSLATORS: Summary of a keyboard shortcut function
        // Example: Enter a new shortcut to change Messaging
        this.summary = _('Enter a new shortcut to change <b>%s</b>').format(
            params.summary
        );
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

    vfunc_key_press_event(event) {
        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();

        // TODO: Critical: 'WIDGET_REALIZED_FOR_EVENT (widget, event)' failed
        if (_MODIFIERS.includes(keyvalLower))
            return true;

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

        // A single Escape press cancels the editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.response(ResponseType.CANCEL);
            return false;
        }

        // Backspace disables the current shortcut
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this.response(ResponseType.UNSET);
            return false;
        }

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower !== 0 && realMask !== 0) {
            // Set the accelerator property/label
            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);

            // Show Cancel button and switch to confirm page
            this.cancel_button.visible = true;
            this.stack.visible_child_name = 'confirm';

            this._check();
        }

        return true;
    }

    _check() {
        try {
            // No known way to check availability, so don't. Don't grab input,
            // so we don't accidentally overload accelerators as easily
            const available = true;
            this.set_button.visible = available;
        } catch (e) {
            logError(e);
            this.response(ResponseType.CANCEL);
        }
    }

    // Override with a non-blocking version of Gtk.Dialog.run()
    run() {
        this.show();
    }
});


/**
 * Show a dialog to get a keyboard shortcut from a user.
 *
 * @param {string} summary - A description of the keybinding's function
 * @param {string} accelerator - An accelerator as taken by Gtk.ShortcutLabel
 * @returns {string} An accelerator or %null if it should be unset.
 */
export async function getAccelerator(summary, accelerator = null) {
    try {
        const dialog = new ShortcutChooserDialog({
            summary: summary,
            accelerator: accelerator,
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

                dialog.destroy();

                resolve(accelerator);
            });

            dialog.run();
        });

        return accelerator;
    } catch (e) {
        logError(e);
        return accelerator;
    }
}
