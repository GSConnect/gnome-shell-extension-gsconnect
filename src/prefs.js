// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib, Adw} = imports.gi; //todo port import

// Bootstrap
import * as Utils from "./shell/utils.js";

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

