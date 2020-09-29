'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Config = imports.config;


/*
 * Window State
 */
Gtk.Window.prototype.restoreGeometry = function (context = 'default') {
    this._windowState = new Gio.Settings({
        settings_schema: Config.GSCHEMA.lookup(
            'org.gnome.Shell.Extensions.GSConnect.WindowState',
            true
        ),
        path: `/org/gnome/shell/extensions/gsconnect/${context}/`,
    });

    // Size
    const [width, height] = this._windowState.get_value('window-size').deepUnpack();

    if (width && height)
        this.set_default_size(width, height);

    // Maximized State
    if (this._windowState.get_boolean('window-maximized'))
        this.maximize();
};

Gtk.Window.prototype.saveGeometry = function () {
    const state = this.get_window().get_state();

    // Maximized State
    const maximized = (state & Gdk.WindowState.MAXIMIZED);
    this._windowState.set_boolean('window-maximized', maximized);

    // Leave the size at the value before maximizing
    if (maximized || (state & Gdk.WindowState.FULLSCREEN))
        return;

    // Size
    const size = this.get_size();
    this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
};

