// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

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

    if (width && height)
        this.set_default_size(width, height);

    // Maximized State
    if (this._windowState.get_boolean('window-maximized'))
        this.maximize();
};

Gtk.Window.prototype.saveGeometry = function () {
    if (this._windowState === undefined)
        return;

    // Maximized State
    const maximized = this.maximized;
    this._windowState.set_boolean('window-maximized', maximized);

    // Leave the size at the value before maximizing
    if (maximized || this.fullscreened)
        return;

    // Size
    const size = [this.get_width(), this.get_height()];
    this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
};


/**
 * Get a snapshot of the children of a widget, since GTK4 no longer has
 * `get_children()`. The result is a copy, so it is safe to remove children
 * while iterating it.
 *
 * @param {Gtk.Widget} widget - A container widget
 * @returns {Gtk.Widget[]} The children of @widget
 */
export function children(widget) {
    const result = [];
    let child = widget.get_first_child();

    while (child !== null) {
        result.push(child);
        child = child.get_next_sibling();
    }

    return result;
}
