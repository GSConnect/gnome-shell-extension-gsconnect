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
            this.emit('response', this, Gtk.ResponseType.CANCEL);
        });
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
    
        // Convertiamo il valore del tasto in minuscolo
        let keyvalLower = Gdk.keyval_to_lower(keyval);
        // Usiamo il state fornito, mascherando solo i bit di modificatore validi
        let realMask = state & Gtk.accelerator_get_default_mod_mask();
    
        // Ignora i modificatori puri (es. Shift, Ctrl, Alt)
        if (_MODIFIERS.includes(keyvalLower)) {
            return Gdk.EVENT_STOP;
        }
    
        // Normalizziamo Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }
    
        // Gestiamo lo Shift (maiuscole)
        if (keyvalLower !== keyval) {
            realMask |= Gdk.ModifierType.SHIFT_MASK;
        }
        
        // Evita che Alt+Print venga interpretato come SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req &&
            (realMask & Gdk.ModifierType.MOD1_MASK) !== 0) {
            keyvalLower = Gdk.KEY_Print;
        }
    
        // Esc cancella l'editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.emit('response', this, Gtk.ResponseType.CANCEL);
            return Gdk.EVENT_STOP;
        }
    
        // Backspace disabilita il collegamento corrente
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this.emit('response', this, Gtk.ResponseType.UNSET);
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
    
    async _check() {
        try {
            const available = await checkAccelerator(this.accelerator);
            this.set_button.visible = available;
            this.conflict_label.visible = !available;
        } catch (e) {
            logError(e);
            this.emit('response', this, ResponseType.CANCEL);
        }
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
                dialog.close();
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
