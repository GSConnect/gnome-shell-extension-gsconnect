'use strict';

const Config = imports.misc.config;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const SHELL_VERSION_MINOR = parseInt(Config.PACKAGE_VERSION.split('.')[1]);


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
var Manager = class Manager {

    constructor() {
        this._keybindings = new Map();

        this._acceleratorActivatedId = global.display.connect(
            'accelerator-activated',
            this._onAcceleratorActivated.bind(this)
        );
    }

    _onAcceleratorActivated(display, action, deviceId, timestamp) {
        try {
            let binding = this._keybindings.get(action);

            if (binding !== undefined) {
                binding.callback();
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Add a keybinding with callback
     *
     * @param {String} accelerator - An accelerator in the form '<Control>q'
     * @param {Function} callback - A callback for the accelerator
     * @return {Number} - A non-zero action id on success, or 0 on failure
     */
    add(accelerator, callback) {
        let action = Meta.KeyBindingAction.NONE;

        // A flags argument was added somewhere between 3.30-3.32
        if (SHELL_VERSION_MINOR > 30) {
            action = global.display.grab_accelerator(accelerator, 0);
        } else {
            action = global.display.grab_accelerator(accelerator);
        }

        if (action !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
            this._keybindings.set(action, {name: name, callback: callback});
        } else {
            logError(new Error(`Failed to add keybinding: '${accelerator}'`));
        }

        return action;
    }

    /**
     * Remove a keybinding
     *
     * @param {Number} accelerator - A non-zero action id returned by add()
     */
    remove(action) {
        try {
            let binding = this._keybindings.get(action);
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
        for (let action of this._keybindings.keys()) {
            this.remove(action);
        }
    }

    /**
     * Destroy the keybinding manager and remove all keybindings
     */
    destroy() {
        global.display.disconnect(this._acceleratorActivatedId);
        this.removeAll();
    }
};

