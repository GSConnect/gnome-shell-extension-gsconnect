'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/**
 * Response enum for the Shortcut Editor
 */
const ResponseType = {
    CANCEL: 0,
    DELETE: 1,
    SAVE:   2
};


/**
 * A simplified version of the shortcut editor from Gnome Control Center
 */
var ShortcutEditor = GObject.registerClass({
    GTypeName: 'GSConnectShortcutEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/shortcut-editor.ui',
    Children: [
        // HeaderBar
        'cancel-button', 'set-button',
        //
        'stack',
        'shortcut-summary',
        'edit-shortcut', 'confirm-shortcut',
        'conflict-label'
    ]
}, class ShortcutEditor extends Gtk.Dialog {

    _init(params) {
        this.connect_template();

        super._init({
            transient_for: params.transient_for,
            use_header_bar: true,
            modal: true
        });

        this.seat = Gdk.Display.get_default().get_default_seat();

        // Content
        this.shortcut_summary.label = _('Enter a new shortcut to change <b>%s</b>').format(
            params.summary
        );

        this.shortcut_label = new Gtk.ShortcutLabel({
            accelerator: params.accelerator,
            disabled_text: _('Disabled'),
            hexpand: true,
            halign: Gtk.Align.CENTER,
            visible: true
        });
        this.confirm_shortcut.attach(this.shortcut_label, 0, 0, 1, 1);
    }

    get accelerator() {
        return this.shortcut_label.accelerator;
    }

    _onDeleteEvent() {
        this.disconnect_template();
        return false;
    }

    _onKeyPressEvent(widget, event) {
        if (!this._gdkDevice) {
            return false;
        }

        let keyval = event.get_keyval()[1];
        let keyvalLower = Gdk.keyval_to_lower(keyval);

        let state = event.get_state()[1];
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // TODO: Remove modifier keys
        let mods = [
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
            Gdk.KEY_Super_R
        ];
        if (mods.indexOf(keyvalLower) > -1) {
            return true;
        }

        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }

        // Put shift back if it changed the case of the key, not otherwise.
        if (keyvalLower !== keyval) {
            realMask |= Gdk.ModifierType.SHIFT_MASK;
        }

        // HACK: we don't want to use SysRq as a keybinding (but we do want
        // Alt+Print), so we avoid translation from Alt+Print to SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.MOD1_MASK) !== 0) {
            keyvalLower = Gdk.KEY_Print;
        }

        // A single Escape press cancels the editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            return this._onCancel();
        }

        // Backspace disables the current shortcut
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            return this._onRemove();
        }

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower !== 0 && realMask !== 0) {
            this.ungrab();

            this.cancel_button.visible = true;

            // Switch to confirm/conflict page
            this.stack.set_visible_child_name('confirm-shortcut');
            // Show shortcut icons
            this.shortcut_label.accelerator = Gtk.accelerator_name(
                keyvalLower,
                realMask
            );

            // Show the Set button if available
            if (this.check(this.accelerator)) {
                this.set_button.visible = true;
            // Otherwise report the conflict
            } else {
                this.conflict_label.label = _('%s is already being used').format(
                    Gtk.accelerator_get_label(keyvalLower, realMask)
                );
                this.conflict_label.visible = true;
            }
        }

        return true;
    }

    _onCancel() {
        return this.response(ResponseType.CANCEL);
    }

    _onSet() {
        return this.response(ResponseType.SAVE);
    }

    _onRemove() {
        return this.response(ResponseType.DELETE);
    }

    _grabAccelerator(accelerator, flags=0) {
        return Gio.DBus.session.call_sync(
            'org.gnome.Shell',
            '/org/gnome/Shell',
            'org.gnome.Shell',
            'GrabAccelerator',
            new GLib.Variant('(su)', [accelerator, flags]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deep_unpack()[0];
    }

    _ungrabAccelerator(action) {
        return Gio.DBus.session.call_sync(
            'org.gnome.Shell',
            '/org/gnome/Shell',
            'org.gnome.Shell',
            'UngrabAccelerator',
            new GLib.Variant('(u)', [action]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deep_unpack()[0];
    }

    response(response_id) {
        this.hide();
        this.ungrab();

        super.response(response_id);
    }

    check(accelerator) {
        // Check someone else isn't already using the binding
        let action = this._grabAccelerator(accelerator);

        if (action !== 0) {
            this._ungrabAccelerator(action);
            return true;
        }

        return false;
    }

    grab() {
        let success = this.seat.grab(
            this.get_window(),
            Gdk.SeatCapabilities.KEYBOARD,
            true, // owner_events
            null, // cursor
            null, // event
            null
        );

        if (success !== Gdk.GrabStatus.SUCCESS) {
            this._onCancel();
        }

        this._gdkDevice = this.seat.get_keyboard();
        this._gdkDevice = this._gdkDevice || this.seat.get_pointer();
        this.grab_add();
    }

    ungrab() {
        this.seat.ungrab();
        this.grab_remove();
        delete this._gdkDevice;
    }

    // Override with a non-blocking version of Gtk.Dialog.run()
    run() {
        this.show();

        // Wait a bit before attempting grab
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.grab();
            return GLib.SOURCE_REMOVE;
        });
    }
});



function _grabAccelerator(accelerator, flags=0) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.gnome.Shell',
            '/org/gnome/Shell',
            'org.gnome.Shell',
            'GrabAccelerator',
            new GLib.Variant('(su)', [accelerator, flags]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, res) => {
                try {
                    res = connection.call_finish(res);
                    resolve(res.deep_unpack[0]);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function _ungrabAccelerator(action) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call_sync(
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
                    resolve(res.deep_unpack[0]);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}


/**
 * A convenience function for checking the availability of an accelerator.
 *
 * @param {string} - An accelerator
 */
async function check_keybinding(accelerator) {
    try {
        // Check someone else isn't already using the binding
        let action = await _grabAccelerator(accelerator);

        if (action !== 0) {
            await _ungrabAccelerator(action);
            return true;
        }

        return false;
    } catch (e) {
        return false;
    }
}


/**
 * A function for using a dialog to get a keyboard shortcut from a user.
 *
 * @param {Gtk.Widget} parent - The top-level widget to be transient of or %null
 * @param {string} summary - A description of the keybinding's function
 * @param {string} accelerator - An accelerator as taken by Gtk.ShortcutLabel
 * @return {string} - Will return a accelerator, possibly modifed @accelerator,
 *                    or %undefined if it should be deleted.
 */
async function get_keybinding(parent, summary, accelerator=null) {
    let dialog;

    try {
        dialog = new ShortcutEditor({
            transient_for: parent,
            summary: summary,
            accelerator: accelerator
        });

        accelerator = await new Promise((resolve, reject) => {
            dialog.connect('response', (dialog, response) => {
                let accelerator;

                switch (response) {
                    case ResponseType.SAVE:
                        accelerator = dialog.accelerator;
                        break;

                    case ResponseType.DELETE:
                        accelerator = undefined;
                        break;

                    case ResponseType.CANCEL:
                        accelerator = dialog.accelerator;
                        break;
                }

                dialog.destroy();
                resolve(accelerator);
            });

            dialog.run();
        });
    } catch (e) {
    } finally {
        return accelerator;
    }
}

