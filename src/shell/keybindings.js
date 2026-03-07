// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

/**
 * @callback KeybindingCallback
 * @returns {void}
 */

/**
 * Keybindings.Manager is a simple convenience class for managing keyboard
 * shortcuts in GNOME Shell. You bind a shortcut using add(), which on success
 * will return a non-zero action id that can later be used with remove() to
 * unbind the shortcut.
 *
 * Accelerators are accepted in the form returned by Gtk.accelerator_name() and
 * callbacks are invoked directly, so should be complete closures.
 *
 * References:
 *     https://developer.gnome.org/gtk3/stable/gtk3-Keyboard-Accelerators.html
 *     https://developer.gnome.org/meta/stable/MetaDisplay.html
 *     https://developer.gnome.org/meta/stable/meta-MetaKeybinding.html
 *     https://gitlab.gnome.org/GNOME/gnome-shell/blob/master/js/ui/windowManager.js#L1093-1112
 */
export class Manager {

    constructor() {
        this._keybindings = new Map();

        this._acceleratorActivatedId = global.display.connect(
            'accelerator-activated',
            this._onAcceleratorActivated.bind(this)
        );
    }

    _onAcceleratorActivated(display, action, inputDevice, timestamp) {
        try {
            const binding = this._keybindings.get(action);

            if (binding !== undefined)
                binding.callback();
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Add a keybinding with callback
     *
     * @param {string} accelerator - An accelerator in the form '<Control>q'
     * @param {KeybindingCallback} callback - A callback for the accelerator
     * @returns {number} A non-zero action id on success, or 0 on failure
     */
    add(accelerator, callback) {
        try {
            const action = global.display.grab_accelerator(accelerator, 0);

            if (action === Meta.KeyBindingAction.NONE)
                throw new Error(`Failed to add keybinding: '${accelerator}'`);

            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
            this._keybindings.set(action, {name: name, callback: callback});

            return action;
        } catch (e) {
            logError(e);
            return 0;
        }
    }

    /**
     * Remove a keybinding
     *
     * @param {number} action - A non-zero action id returned by add()
     */
    remove(action) {
        try {
            const binding = this._keybindings.get(action);
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(binding.name, Shell.ActionMode.NONE);
            this._keybindings.delete(action);
        } catch (e) {
            logError(new Error(`Failed to remove keybinding: ${e.message}`));
        }
    }

    /**
     * Remove all keybindings
     */
    removeAll() {
        for (const action of this._keybindings.keys())
            this.remove(action);
    }

    /**
     * Destroy the keybinding manager and remove all keybindings
     */
    destroy() {
        global.display.disconnect(this._acceleratorActivatedId);
        this.removeAll();
    }
}
