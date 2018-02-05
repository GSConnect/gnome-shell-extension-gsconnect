"use strict";

const Gio = imports.gi.Gio;
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
const Settings = imports.modules.settings;


function init() {
    debug("initializing extension preferences");

    gsconnect.installService();
    Gtk.IconTheme.get_default().add_resource_path(gsconnect.app_path);
}

function buildPrefsWidget() {
    debug("Prefs: buildPrefsWidget()");

    return new Settings.PrefsWidget();
}

