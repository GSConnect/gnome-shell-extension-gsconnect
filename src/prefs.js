'use strict';

const {Gio, GLib, Adw} = imports.gi;

// Bootstrap
const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Extension.imports.shell.utils;

function init() {
    Utils.installService();
}

function fillPreferencesWindow(window) {
    const widget = new Adw.PreferencesPage();
    window.add(widget);

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        window.close();
    });

    Gio.Subprocess.new([`${Extension.path}/gsconnect-preferences`], 0);
}

