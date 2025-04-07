// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import Config from '../../config.js';


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

    if (width > 0 && height > 0)
        this.set_default_size(width, height);

    // Maximized State
    if (this._windowState.get_boolean('window-maximized'))
        this.set_maximized(true);  // GTK 4 way to maximize
};

Gtk.Window.prototype.saveGeometry = function () {
    const maximized = this.is_maximized();  // GTK 4 method
    this._windowState.set_boolean('window-maximized', maximized);

    if (maximized || this.is_fullscreen())
        return;

    // Size
    const width = this.get_allocated_width();
    const height = this.get_allocated_height();
    this._windowState.set_value('window-size', new GLib.Variant('(ii)', [width, height]));
};
