'use strict';

const Gettext = imports.gettext;

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Config = Extension.imports.config;
Config.PACKAGE_DATADIR = Extension.path;


// Ensure config.js is setup properly
if (Config.PACKAGE_DATADIR.startsWith(GLib.get_home_dir())) {
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

