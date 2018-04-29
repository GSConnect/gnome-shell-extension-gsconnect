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

window.gsconnect = { datadir: getPath() };
imports.searchPath.unshift(gsconnect.datadir);
imports._gsconnect;

// Local Imports
const DBus = imports.modules.dbus;


const ServiceProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface(gsconnect.app_id)
);


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

    let daemon = new ServiceProxy({
        g_connection: Gio.DBus.session,
        g_name: gsconnect.app_id,
        g_object_path: gsconnect.app_path
    });
    daemon.OpenSettings().then(result => daemon.destroy());

    return label;
}

