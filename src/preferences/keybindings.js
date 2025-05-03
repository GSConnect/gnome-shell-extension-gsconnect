// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
 * A simplified version of the shortcut editor from GNOME Control Center.
 * This dialog allows the user to set a keyboard shortcut and handles key press events.
 *
 * @class ShortcutChooserDialog
 * @augments {Adw.Dialog}
 */
export const ShortcutChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesShortcutEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-shortcut-editor.ui',
    Children: [
        'cancel-button', 'set-button',
        'stack', 'summary-label', 'confirm',
        'shortcut-label', 'conflict-label',
    ],
    Properties: {
        'accelerator': GObject.ParamSpec.string(
            'accelerator',
            'Accelerator',
            'The accelerator key combination',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'summary': GObject.ParamSpec.string(
            'summary',
            'Summary',
            'The summary of key combination',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Signals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    },
}, class ShortcutChooserDialog extends Adw.Dialog {

    _init(params) {
        super._init();
        Object.assign(params);

        // TRANSLATORS: Summary of a keyboard shortcut function
        // Example: Enter a new shortcut to change Messaging
        this.summary = _('Enter a new shortcut to change <b>%s</b>').format(
            params.summary
        );

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', this._onKeyPressed.bind(this));

        // Aggiungi il controller al widget
        this.add_controller(keyController);

        this.cancel_button.connect('clicked', () => {
            this.response = Gtk.ResponseType.CANCEL;
        });
    }

    /**
     * Sets the response and emits the 'response' signal, then closes the dialog.
     *
     * @type {number} response - The response type (e.g., Gtk.ResponseType.OK).
     */
    set response(response) {
        this.emit('response', this, response);
        this.close();
    }

    /**
     * Gets or sets the accelerator for the shortcut.
     *
     * The `accelerator` represents the keyboard shortcut assigned to the current action. The getter retrieves the
     * current accelerator value, while the setter updates the accelerator and applies it to the corresponding
     * shortcut label in the UI.
     *
     * @type {string}
     */
    get accelerator() {
        return this.shortcut_label.accelerator;
    }

    set accelerator(value) {
        this.shortcut_label.accelerator = value;
    }

    /**
     * Gets or sets the summary description for the shortcut.
     *
     * The `summary` provides a textual description of the shortcut's function. The getter retrieves the current
     * summary, while the setter updates the summary label in the UI to reflect the new description.
     *
     * @type {string}
     */
    get summary() {
        return this.summary_label.label;
    }

    set summary(value) {
        this.summary_label.label = value;
    }

    /**
     * Handles key press events and processes the key combination to set an accelerator.
     *
     * This function is triggered when a key press event occurs. It converts the key value to a lowercase
     * representation, processes the key combination, and checks for conflicts with existing accelerators.
     * It also handles special cases like the Escape key for canceling, Backspace for unsetting,
     * and modifiers such as Shift for capitalization. Additionally, it ensures that common key combinations
     * like Alt+Print are handled correctly and provides feedback if a key is already in use.
     *
     * @param {object} controller - The controller instance managing the UI or actions.
     * @param {number} keyval - The key value representing the pressed key.
     * @param {number} keycode - The hardware key code for the pressed key.
     * @param {number} state - The state of the key modifiers (e.g., Shift, Ctrl, Alt).
     *
     * @returns {number} `Gdk.EVENT_STOP` to indicate the event is processed and should not propagate further.
     */
    _onKeyPressed(controller, keyval, keycode, state) {

        // Convertiamo il valore del tasto in minuscolo
        let keyvalLower = Gdk.keyval_to_lower(keyval);
        // Usiamo il state fornito, mascherando solo i bit di modificatore validi
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // Ignora i modificatori puri (es. Shift, Ctrl, Alt)
        if (_MODIFIERS.includes(keyvalLower))
            return Gdk.EVENT_STOP;


        // Normalizziamo Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab)
            keyvalLower = Gdk.KEY_Tab;


        // Gestiamo lo Shift (maiuscole)
        if (keyvalLower !== keyval)
            realMask |= Gdk.ModifierType.SHIFT_MASK;


        // Evita che Alt+Print venga interpretato come SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req &&
            (realMask & Gdk.ModifierType.MOD1_MASK) !== 0)
            keyvalLower = Gdk.KEY_Print;


        // Esc cancella l'editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.response = Gtk.ResponseType.CANCEL;
            return Gdk.EVENT_STOP;
        }

        // Backspace disabilita il collegamento corrente
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this.response = Gtk.ResponseType.REJECT;
            return Gdk.EVENT_STOP;
        }

        // Ignoriamo CapsLock
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        // Se abbiamo un tasto + modificatore valido
        if (keyvalLower !== 0 && realMask !== 0) {

            // Imposta l'acceleratore e aggiorna l'etichetta
            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);
            this.conflict_label.label = _('%s è già in uso').format(
                Gtk.accelerator_get_label(keyvalLower, realMask)
            );

            this.cancel_button.visible = true;
            this.stack.visible_child = this.confirm;

            this._check();
        }

        return Gdk.EVENT_STOP;
    }

    /**
     * Checks the availability of the current accelerator and updates the UI accordingly.
     *
     * This function verifies if the currently set accelerator is available using the `checkAccelerator` function.
     * If the accelerator is available, the "set" button is displayed, and the conflict label is hidden.
     * If the accelerator is not available, the conflict label is shown to inform the user. In case of any error
     * during the check process, the function logs the error and emits a cancel response.
     *
     * @returns {Promise<void>} A promise that resolves once the availability check is completed.
     */
    async _check() {
        try {
            const available = await checkAccelerator(this.accelerator);
            this.set_button.visible = available;
            this.conflict_label.visible = !available;
        } catch (e) {
            logError(e);
            this.response = Gtk.ResponseType.CANCEL;
        }
    }
});


/**
 * Checks the availability of a specified keyboard accelerator using GNOME Shell's DBus interface.
 *
 * This function attempts to grab the specified accelerator (keybinding) and checks whether it is
 * available for use in the GNOME Shell environment. If successful, it ungrabs the accelerator
 * immediately after checking its availability. This is typically used to verify if a keybinding
 * can be used or if it is already in use by another action.
 *
 * @param {string} accelerator - The accelerator (keybinding) to check, as a string
 *                                (e.g., 'Ctrl+Alt+T').
 * @param {number} [modeFlags] - Mode flags that modify how the accelerator is handled.
 * @param {number} [grabFlags] - Grab flags that control the behavior of the grab operation.
 *
 * @returns {boolean} Returns `true` if the accelerator is available, and `false` if
 *                   it is either unavailable or an error occurs.
 */
export async function checkAccelerator(accelerator, modeFlags = 0, grabFlags = 0) {
    try {
        let result = false;

        // Try to grab the accelerator
        const action = await new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.gnome.Shell',
                '/org/gnome/Shell',
                'org.gnome.Shell',
                'GrabAccelerator',
                new GLib.Variant('(suu)', [accelerator, modeFlags, grabFlags]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        // If successful, use the result of ungrabbing as our return
        if (action !== 0) {
            result = await new Promise((resolve, reject) => {
                Gio.DBus.session.call(
                    'org.gnome.Shell',
                    '/org/gnome/Shell',
                    'org.gnome.Shell',
                    'UngrabAccelerator',
                    new GLib.Variant('(u)', [action]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, res) => {
                        try {
                            res = connection.call_finish(res);
                            resolve(res.deepUnpack()[0]);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        }

        return result;
    } catch (e) {
        logError(e);
        return false;
    }
}


/**
 * Opens a dialog to allow the user to set or unset a keyboard shortcut.
 *
 * This function presents a dialog where the user can define a keyboard shortcut
 * for a specific action, or choose to unset the existing one. The dialog will
 * display a description of the keybinding's function, and the user can either
 * assign a new shortcut, leave it unchanged, or reset it to null.
 *
 * @param {string} summary - A description of the function for which the shortcut
 *                            is being set (e.g., "Open file", "Save document").
 * @param {string|null} accelerator - The current shortcut (if any) to be shown
 *                                     in the dialog, or `null` if no shortcut
 *                                     is set.
 *
 * @returns {Promise<string|null>} A promise that resolves to the new keyboard
 *                                shortcut (as a string) or `null` if the shortcut
 *                                is unset. If the dialog is canceled, it
 *                                resolves to the initial value of `accelerator`.
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
                    case Gtk.ResponseType.OK:
                        accelerator = dialog.accelerator;
                        break;

                    case Gtk.ResponseType.REJECT:
                        accelerator = null;
                        break;

                    case Gtk.ResponseType.CANCEL:
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
