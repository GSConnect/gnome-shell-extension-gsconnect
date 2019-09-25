'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;


/**
 * TODO: required for GJS 1.52 (GNOME 3.28)
 */
Gtk.Widget.prototype.connectTemplate = function() {
    this.$templateHandlers = [];

    Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
        this.$templateHandlers.push([
            obj,
            obj.connect(signalName, this[handlerName].bind(this))
        ]);
    });
};

Gtk.Widget.prototype.disconnectTemplate = function() {
    Gtk.Widget.set_connect_func.call(this, function() {});
    this.$templateHandlers.map(([obj, id]) => obj.disconnect(id));
};


/**
 * Window State
 */
Gtk.Window.prototype.restoreGeometry = function(context = 'default') {
    this._windowState = new Gio.Settings({
        settings_schema: gsconnect.gschema.lookup(
            'org.gnome.Shell.Extensions.GSConnect.WindowState',
            true
        ),
        path: `/org/gnome/shell/extensions/gsconnect/${context}/`
    });

    // Size
    let [width, height] = this._windowState.get_value('window-size').deep_unpack();

    if (width && height) {
        this.set_default_size(width, height);
    }

    // Maximized State
    if (this._windowState.get_boolean('window-maximized')) {
        this.maximize();
    }
};

Gtk.Window.prototype.saveGeometry = function() {
    let state = this.get_window().get_state();

    // Maximized State
    let maximized = (state & Gdk.WindowState.MAXIMIZED);
    this._windowState.set_boolean('window-maximized', maximized);

    // Leave the size at the value before maximizing
    if (maximized || (state & Gdk.WindowState.FULLSCREEN))
        return;

    // Size
    let size = this.get_size();
    this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
};

