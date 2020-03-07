'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Bootstrap
const Extension = imports.misc.extensionUtils.getCurrentExtension();
Extension.imports._gsconnect;


function init() {
    gsconnect.installService();
}

function buildPrefsWidget() {
    // Destroy the window once the mainloop starts
    let label = new Gtk.Label();

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
        label.get_toplevel().destroy();
        return false;
    });

    // Exec `gsconnect-preferences
    let proc = new Gio.Subprocess({
        argv: [Extension.path + '/gsconnect-preferences']
    });
    proc.init(null);
    proc.wait_async(null, null);

    return label;
}

