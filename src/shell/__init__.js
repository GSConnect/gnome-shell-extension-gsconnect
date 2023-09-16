// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const Extension = imports.misc.extensionUtils.getCurrentExtension(); // FIXME
import Config from '../config.js';
Config.PACKAGE_DATADIR = Extension.path; // FIXME


// Ensure config.js is setup properly
const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell']);

if (Config.PACKAGE_DATADIR.startsWith(userDir)) {
    Config.IS_USER = true;

    Config.GSETTINGS_SCHEMA_DIR = `${Extension.path}/schemas`;
    Config.PACKAGE_LOCALEDIR = `${Extension.path}/locale`;
}


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

