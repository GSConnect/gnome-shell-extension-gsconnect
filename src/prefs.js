"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Bootstrap
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

// Local Imports
window.gsconnect = { extdatadir: getPath() };
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;


function init() {
    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);
}

function buildPrefsWidget() {
    let label = new Gtk.Label();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
        label.get_toplevel().destroy();
        return false;
    });

    let service = Gio.DBusActionGroup.get(
        Gio.DBus.session,
        'org.gnome.Shell.Extensions.GSConnect',
        '/org/gnome/Shell/Extensions/GSConnect'
    );
    service.list_actions();
    service.activate_action('openSettings', null);

    return label;
}

