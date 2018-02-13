"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

window.gsconnect = { datadir: getPath() };
imports.searchPath.push(gsconnect.datadir);
const _bootstrap = imports._bootstrap;
const Client = imports.client;


function init() {
    debug("initializing extension preferences");

    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);
}

function buildPrefsWidget() {
    debug("Prefs: buildPrefsWidget()");

    let label = new Gtk.Label();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
        label.get_toplevel().destroy();
        return false;
    });

    let daemon = new Client.Daemon();
    daemon.openSettings().then(result => daemon.destroy());

    return label;
}

