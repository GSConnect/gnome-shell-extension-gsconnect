// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
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
    CANCEL: 'cancel',
    SET: 'set',
    UNSET: 'unset',
};


/**
 * A simplified version of the shortcut editor from GNOME Control Center
 */
export const ShortcutChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesShortcutEditor',
    Signals: {
        'response': {param_types: [GObject.TYPE_STRING]},
    },
}, class ShortcutChooserDialog extends Adw.Dialog {

    _init(params) {
        super._init({
            title: _('Set Shortcut'),
            content_width: 440,
        });

        this._accelerator = params.accelerator ?? null;
        this._buildUI(params.summary);

        // Capture keys before any child widget can consume them
        const keys = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keys.connect('key-pressed', this._onKeyPressed.bind(this));
        this.add_controller(keys);

        this.connect('closed', () => this.emit('response', this._response ?? ResponseType.CANCEL));
    }

    _buildUI(summary) {
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        toolbar.set_content(box);

        // TRANSLATORS: Summary of a keyboard shortcut function
        // Example: Enter a new shortcut to change Messaging
        box.append(new Gtk.Label({
            label: _('Enter a new shortcut to change <b>%s</b>').format(
                GLib.markup_escape_text(summary, -1)
            ),
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }));

        const note = new Gtk.Label({
            label: _('Note that you have to first disable any conflicting shortcuts in GNOME Settings.'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        note.add_css_class('dim-label');
        box.append(note);

        this._stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
        box.append(this._stack);

        const edit = new Adw.StatusPage({
            icon_name: 'input-keyboard-symbolic',
            // TRANSLATORS: Keys for cancelling (␛) or resetting (␈) a shortcut
            description: _('Press Esc to cancel or Backspace to reset the keyboard shortcut.'),
        });
        edit.add_css_class('compact');
        this._stack.add_named(edit, 'edit');

        const confirm = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            halign: Gtk.Align.CENTER,
        });
        this._shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: this._accelerator ?? '',
            halign: Gtk.Align.CENTER,
        });
        confirm.append(this._shortcutLabel);

        const buttons = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER});
        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this._finish(ResponseType.CANCEL));
        const set = new Gtk.Button({label: _('Set')});
        set.add_css_class('suggested-action');
        set.connect('clicked', () => this._finish(ResponseType.SET));
        buttons.append(cancel);
        buttons.append(set);
        confirm.append(buttons);
        this._stack.add_named(confirm, 'confirm');

        this.set_child(toolbar);
    }

    get accelerator() {
        return this._accelerator;
    }

    _finish(response) {
        this._response = response;
        this.close();
    }

    _onKeyPressed(controller, keyval, keycode, state) {
        let keyvalLower = Gdk.keyval_to_lower(keyval);
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        if (_MODIFIERS.includes(keyvalLower))
            return Gdk.EVENT_STOP;

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

        // A single Escape press cancels the editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this._finish(ResponseType.CANCEL);
            return Gdk.EVENT_STOP;
        }

        // Backspace disables the current shortcut
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this._finish(ResponseType.UNSET);
            return Gdk.EVENT_STOP;
        }

        // CapsLock isn't supported as a keybinding modifier
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower !== 0 && realMask !== 0) {
            this._accelerator = Gtk.accelerator_name(keyvalLower, realMask);
            this._shortcutLabel.accelerator = this._accelerator;
            this._stack.visible_child_name = 'confirm';
        }

        return Gdk.EVENT_STOP;
    }
});


/**
 * Show a dialog to get a keyboard shortcut from a user.
 *
 * @param {Gtk.Widget} parent - The widget to present the dialog over
 * @param {string} summary - A description of the keybinding's function
 * @param {string} accelerator - An accelerator as taken by Gtk.ShortcutLabel
 * @returns {Promise<string|null>} An accelerator or %null if it should be unset.
 */
export async function getAccelerator(parent, summary, accelerator = null) {
    try {
        const dialog = new ShortcutChooserDialog({summary, accelerator});

        return await new Promise(resolve => {
            dialog.connect('response', (dialog, response) => {
                switch (response) {
                    case ResponseType.SET:
                        resolve(dialog.accelerator);
                        break;

                    case ResponseType.UNSET:
                        resolve(null);
                        break;

                    default:
                        // leave the accelerator as passed in
                        resolve(accelerator);
                }
            });

            dialog.present(parent);
        });
    } catch (e) {
        logError(e);
        return accelerator;
    }
}
