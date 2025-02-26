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
        'shortcut-label', 'conflict-label',
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
        
        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', this._onKeyPressed.bind(this));

        // Aggiungi il controller al widget
        this.add_controller(keyController);
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

    _onKeyPressed(controller, event) {
        // Convertiamo il valore del tasto in minuscolo
        let keyvalLower = Gdk.keyval_to_lower(event.keyval);
        let realMask = event.state & Gtk.accelerator_get_default_mod_mask();
    
        // Ignora i modificatori puri (es. Shift, Ctrl, Alt)
        if (_MODIFIERS.includes(keyvalLower)) {
            return Gdk.EVENT_STOP; // Interrompe la propagazione
        }
    
        // Normalizziamo Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }
    
        // Gestiamo Shift per riconoscere tasti maiuscoli
        if (keyvalLower !== event.keyval) {
            realMask |= Gdk.ModifierType.SHIFT_MASK;
        }
    
        // Evita che Alt+Print venga interpretato come SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.MOD1_MASK) !== 0) {
            keyvalLower = Gdk.KEY_Print;
        }
    
        // Esc cancella l'editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.response(Gtk.ResponseType.CANCEL);
            return Gdk.EVENT_STOP;
        }
    
        // Backspace disabilita il collegamento corrente
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this.response(Gtk.ResponseType.UNSET);
            return Gdk.EVENT_STOP;
        }
    
        // Ignoriamo CapsLock come modificatore
        realMask &= ~Gdk.ModifierType.LOCK_MASK;
    
        // Verifica se c'è una combinazione tasto-modificatore valida
        if (keyvalLower !== 0 && realMask !== 0) {
            this._ungrab(); // Annulla la "presa" attuale
    
            // Configura l'acceleratore e aggiorna l'etichetta
            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);
            this.conflict_label.label = _('%s è già in uso').format(
                Gtk.accelerator_get_label(keyvalLower, realMask)
            );
    
            // Mostra il pulsante "Annulla" e passa alla pagina di conferma
            this.cancel_button.visible = true;
            this.stack.visible_child_name = 'confirm';
    
            // Esegui eventuali controlli di conflitti
            this._check();
        }
    
        return Gdk.EVENT_STOP; // Interrompe la propagazione
    }
    

    async _check() {
        try {
            const available = await checkAccelerator(this.accelerator);
            this.set_button.visible = available;
            this.conflict_label.visible = !available;
        } catch (e) {
            logError(e);
            this.response(ResponseType.CANCEL);
        }
    }

    _grab() {
        const success = this._seat.grab(
            this.get_window(),
            Gdk.SeatCapabilities.KEYBOARD,
            true, // owner_events
            null, // cursor
            null, // event
            null
        );

        if (success !== Gdk.GrabStatus.SUCCESS)
            return this.response(ResponseType.CANCEL);

        if (!this._seat.get_keyboard() && !this._seat.get_pointer())
            return this.response(ResponseType.CANCEL);

        this.grab_add();
    }

    _ungrab() {
        this._seat.ungrab();
        this.grab_remove();
    }

    // Override to use our own ungrab process
    response(response_id) {
        this.hide();
        this._ungrab();

        return super.response(response_id);
    }

    // Override with a non-blocking version of Gtk.Dialog.run()
    run() {
        this.show();

        // Wait a bit before attempting grab
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._grab();
            return GLib.SOURCE_REMOVE;
        });
    }
});


/**
 * Check the availability of an accelerator using GNOME Shell's DBus interface.
 *
 * @param {string} accelerator - An accelerator
 * @param {number} [modeFlags] - Mode Flags
 * @param {number} [grabFlags] - Grab Flags
 * @returns {boolean} %true if available, %false on error or unavailable
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
