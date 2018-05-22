'use strict';

const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;


/**
 * Keyboard shortcuts
 *
 * References:
 *     https://developer.gnome.org/meta/stable/MetaDisplay.html
 *     https://developer.gnome.org/meta/stable/meta-MetaKeybinding.html
 */
var Manager = class Manager {

    constructor() {
        this.bindings = new Map();

        this._acceleratorActivatedId = global.display.connect(
            'accelerator-activated',
            this._onAcceleratorActivated.bind(this)
        );
    }

    _onAcceleratorActivated(display, action, deviceId, timestamp) {
        let binding = this.bindings.get(action);

        if (binding) {
            binding.callback();
        }
    }

    add(accelerator, callback) {
        debug(arguments);

        let action = global.display.grab_accelerator(accelerator);

        if (action !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(action);

            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL)

            this.bindings.set(action, {
                name: name,
                callback: callback
            });
        } else {
            debug(`Failed to grab accelerator '${accelerator}'`);
        }

        return action;
    }

    remove(action) {
        let binding = this.bindings.get(action);

        if (binding) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(binding.name, Shell.ActionMode.NONE);
            this.bindings.delete(action);
        }
    }

    destroy() {
        global.display.disconnect(this._acceleratorActivatedId);

        for (let action of this.bindings.keys()) {
            this.remove(action);
        }
    }
}

