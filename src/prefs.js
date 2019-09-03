'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Find the root datadir of the extension
function get_datadir() {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

// Local Imports
window.gsconnect = {extdatadir: get_datadir()};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;


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
        argv: [gsconnect.extdatadir + '/gsconnect-preferences']
    });
    proc.init(null);
    proc.wait_async(null, null);

    return label;
}

