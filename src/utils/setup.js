// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import Gettext from 'gettext';

import Config from '../config.js';


/**
 * Initialise and setup Gettext.
 */
export function setupGettext() {
    // Init Gettext
    String.prototype.format = imports.format.format;
    Gettext.bindtextdomain(Config.APP_ID, Config.PACKAGE_LOCALEDIR);
    globalThis._ = GLib.dgettext.bind(null, Config.APP_ID);
    globalThis.ngettext = GLib.dngettext.bind(null, Config.APP_ID);
}

/**
 * Initialise and setup Config, GResources and GSchema.
 * @param {string} extensionPath - The absolute path to the extension directory
 */
export default function setup(extensionPath) {
    // Ensure config.js is setup properly
    Config.PACKAGE_DATADIR = extensionPath;
    const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell']);

    if (Config.PACKAGE_DATADIR.startsWith(userDir)) {
        Config.IS_USER = true;

        Config.GSETTINGS_SCHEMA_DIR = `${Config.PACKAGE_DATADIR}/schemas`;
        Config.PACKAGE_LOCALEDIR = `${Config.PACKAGE_DATADIR}/locale`;
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
}
