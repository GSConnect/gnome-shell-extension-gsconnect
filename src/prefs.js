"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

window.ext = { datadir: getPath() };

imports.searchPath.push(ext.datadir);

const Common = imports.common;
const DaemonWidget = imports.widgets.daemon;


function init() {
    debug("initializing extension preferences");

    Common.installService();
    Gtk.IconTheme.get_default().add_resource_path(ext.app_path);
}

function buildPrefsWidget() {
    debug("Prefs: buildPrefsWidget()");

    return new DaemonWidget.PrefsWidget();
}

