"use strict";

const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;


var ShellProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface("org.gnome.Shell")
);

/**
 *
 */
var ShortcutEditor = new Lang.Class({
    Name: "GSConnectShortcutEditor",
    Extends: Gtk.Dialog,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/shortcut-editor.ui",
    Children: [
        // HeaderBar
        "cancel_button", "set_button",
        //
        "stack",
        "shortcut-summary",
        "edit-shortcut", "confirm-shortcut",
        "conflict-label"
    ],
    Signals: {
        "result": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function (params) {
        // Hack until template callbacks are supported (GJS 1.54?)
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(connectObj));
        });

        this.parent({
            transient_for: params.transient_for,
            use_header_bar: true,
            modal: true
        });

        this.summary = params.summary;
        this.result = "";

        this.shell = new ShellProxy({
            g_connection: Gio.DBus.session,
            g_name: "org.gnome.Shell",
            g_object_path: "/org/gnome/Shell"
        });
        this.shell.init_promise().catch(e => debug(e));

        this.seat = Gdk.Display.get_default().get_default_seat();

        // Content
        this.shortcut_summary.label = _("Enter a new shortcut to change <b>%s</b>").format(this.summary);

        this.shortcut_label = new Gtk.ShortcutLabel({
            accelerator: "",
            disabled_text: _("Disabled"),
            hexpand: true,
            halign: Gtk.Align.CENTER,
            visible: true
        });
        this.confirm_shortcut.attach(this.shortcut_label, 0, 0, 1, 1);
    },

//    /*
//     * Stolen from GtkCellRendererAccel:
//     * https://git.gnome.org/browse/gtk+/tree/gtk/gtkcellrendereraccel.c#n261
//     */
//    gchar*
//    convert_keysym_state_to_string (CcKeyCombo *combo)
//    {
//      gchar *name;

//      if (combo->keyval == 0 && combo->keycode == 0)
//        {
//          /* This label is displayed in a treeview cell displaying
//           * a disabled accelerator key combination.
//           */
//          name = g_strdup (_("Disabled"));
//        }
//      else
//        {
//          name = gtk_accelerator_get_label_with_keycode (NULL, combo->keyval, combo->keycode, combo->mask);

//          if (name == NULL)
//            name = gtk_accelerator_name_with_keycode (NULL, combo->keyval, combo->keycode, combo->mask);
//        }

//      return name;
//    }

    _onKeyPressEvent: function(widget, event) {
        if (!this._grabId) {
            return false;
        }

        let keyval = event.get_keyval()[1];
        let keyvalLower = Gdk.keyval_to_lower(keyval);

        let state = event.get_state()[1];
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // FIXME: Remove modifier keys
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
            log("returning");
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
        // FIXME: or does it...
        if (realMask === 0 && keyvalLower === Gdk.KEY_Esc) {
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

            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);
            this.accelerator_label = Gtk.accelerator_get_label(keyvalLower, realMask);

            log("KEYVAL: " + keyvalLower);
            log("MASK: " + realMask);
            log("SHORTCUT: " + this.accelerator);
            log("SHORTCUT: " + this.accelerator_label);

            // Switch to confirm/conflict page
            this.stack.set_visible_child_name("confirm-shortcut");
            // Show shortcut icons
            this.shortcut_label.accelerator = this.accelerator;

            //FIXME
            // If not available, show confliction
            if (!this.check(this.accelerator)) {
                this.conflict_label.visible = true;
                //_("The requested keyboard shortcut is already in use and can't be overridden.")
                this.conflict_label.label = _("%s is already being used").format(this.accelerator_label);
            // Otherwise the set button
            } else {
                this.set_button.visible = true;
            }

            return true;
        }

        return true;
    },

    _onCancel: function() {
        return this.response(Gtk.ResponseType.CANCEL);
    },

    _onSet: function() {
        return this.response(Gtk.ResponseType.OK);
    },

    response: function(id) {
        this.hide();
        this.ungrab();
        Gtk.Dialog.prototype.response.call(this, id);

        return true;
    },

    check: function(accelerator) {
        // Check someone else isn't already using the binding
        let action = this.shell.grabAccelerator(accelerator, 0);
//        let action = this.shell.call_sync(
//            "GrabAccelerator",
//            new GLib.Variant("(su)", [accelerator, 0]),
//            0,
//            -1,
//            null
//        ).deep_unpack()[0];

        if (action !== 0) {
            this.shell.ungrabAccelerator(action);
//            this.shell.call_sync(
//                "UngrabAccelerator",
//                new GLib.Variant("(u)", [action]),
//                0,
//                -1,
//                null
//            );
            return true;
        }

        return false;
    },

    grab: function() {
        let success = this.seat.grab(
            this.get_window(),
            Gdk.SeatCapabilities.KEYBOARD,
            true, // owner_events
            null, // cursor
            null, // event
            null
        );

        log("Seat Grab: " + success);

        if (success !== Gdk.GrabStatus.SUCCESS) {
            this._onCancel();
        }

        this._grabId = this.seat.get_keyboard();
        this._grabId = this._grabId || this.seat.get_pointer();
        this.grab_add();
    },

    ungrab: function() {
        this.seat.ungrab();
        this.grab_remove();
        delete this._grabId;
    },

    // A non-blocking version of run()
    run: function() {
        this.set_button.visible = false;

        this.show();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.grab();
            return false;
        });
    }
});
