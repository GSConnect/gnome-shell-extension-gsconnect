'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Bootstrap
const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Extension.imports.shell.utils;
const Compat = Extension.imports.compat;

function init() {
    Utils.installService();
}

function buildPrefsWidget() {
    // Destroy the window once the mainloop starts
    const widget = new Gtk.Box();

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        Compat.get_root(widget).destroy();
        return false;
    });

    Gio.Subprocess.new([`${Extension.path}/gsconnect-preferences`], 0);

    return widget;
}

