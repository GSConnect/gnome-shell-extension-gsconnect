// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Gettext = imports.gettext; //todo port import

import * as GLib from "gi://GLib";
import * as Gio from "gi://Gio";
import * as Gtk from "gi://Gtk";

const Extension = imports.misc.extensionUtils.getCurrentExtension(); //todo port import
import * as Config from "./config.js";
Config.PACKAGE_DATADIR = Extension.path;


// Ensure config.js is setup properly
const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell']);

if (Config.PACKAGE_DATADIR.startsWith(userDir)) {
    Config.IS_USER = true;

    Config.GSETTINGS_SCHEMA_DIR = `${Extension.path}/schemas`;
    Config.PACKAGE_LOCALEDIR = `${Extension.path}/locale`;
}


// Init Gettext
Gettext.bindtextdomain(Config.APP_ID, Config.PACKAGE_LOCALEDIR);
Extension._ = GLib.dgettext.bind(null, Config.APP_ID);
Extension.ngettext = GLib.dngettext.bind(null, Config.APP_ID);


// Init GResources
Gio.Resource.load(
    GLib.build_filenamev([Config.PACKAGE_DATADIR, `${Config.APP_ID}.gresource`])
)._register();


// Init GSchema
Config.GSCHEMA = Gio.SettingsSchemaSource.new_from_directory(
    Config.GSETTINGS_SCHEMA_DIR,
    Gio.SettingsSchemaSource.get_default(),
    false
);

