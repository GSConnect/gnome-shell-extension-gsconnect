'use strict';

const Gettext = imports.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Config = imports.config;


// Ensure config.js is setup properly
const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell']);

if (Config.PACKAGE_DATADIR.startsWith(userDir)) {
    Config.IS_USER = true;

    Config.PACKAGE_LOCALEDIR = `${Config.PACKAGE_DATADIR}/locale`;
    Config.GSETTINGS_SCHEMA_DIR = `${Config.PACKAGE_DATADIR}/schemas`;
}


// Init Gettext
String.prototype.format = imports.format.format;
Gettext.bindtextdomain(Config.APP_ID, Config.PACKAGE_LOCALEDIR);
globalThis._ = GLib.dgettext.bind(null, Config.APP_ID);
globalThis.ngettext = GLib.dngettext.bind(null, Config.APP_ID);


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

