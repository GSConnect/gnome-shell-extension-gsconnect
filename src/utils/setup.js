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
 * Get the contents of a GResource file, replacing `@PACKAGE_DATADIR@` where
 * necessary.
 *
 * @param {string} relativePath - A path relative to GSConnect's resource path
 * @returns {string} The file contents as a string
 */
function getResource(relativePath) {
    try {
        const bytes = Gio.resources_lookup_data(
            GLib.build_filenamev([Config.APP_PATH, relativePath]),
            Gio.ResourceLookupFlags.NONE
        );

        const source = new TextDecoder().decode(bytes.toArray());

        return source.replace('@PACKAGE_DATADIR@', Config.PACKAGE_DATADIR);
    } catch (e) {
        logError(e, 'GSConnect');
        return null;
    }
}


/**
 * Install file contents, to an absolute directory path.
 *
 * @param {string} dirname - An absolute directory path
 * @param {string} basename - The file name
 * @param {string} contents - The file contents
 * @returns {boolean} A success boolean
 */
function _installFile(dirname, basename, contents) {
    try {
        const filename = GLib.build_filenamev([dirname, basename]);
        GLib.mkdir_with_parents(dirname, 0o755);

        return GLib.file_set_contents(filename, contents);
    } catch (e) {
        logError(e, 'GSConnect');
        return false;
    }
}

/**
 * Install file contents from a GResource, to an absolute directory path.
 *
 * @param {string} dirname - An absolute directory path
 * @param {string} basename - The file name
 * @param {string} relativePath - A path relative to GSConnect's resource path
 * @returns {boolean} A success boolean
 */
function _installResource(dirname, basename, relativePath) {
    try {
        const contents = getResource(relativePath);

        return _installFile(dirname, basename, contents);
    } catch (e) {
        logError(e, 'GSConnect');
        return false;
    }
}

/**
 * Use Gio.File to ensure a file's executable bits are set.
 *
 * @param {string} filepath - An absolute path to a file
 * @returns {boolean} - True if the file already was, or is now, executable
 */
function _setExecutable(filepath) {
    try {
        const file = Gio.File.new_for_path(filepath);
        const finfo = file.query_info(
            `${Gio.FILE_ATTRIBUTE_STANDARD_TYPE},${Gio.FILE_ATTRIBUTE_UNIX_MODE}`,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);

        if (!finfo.has_attribute(Gio.FILE_ATTRIBUTE_UNIX_MODE))
            return false;

        const mode = finfo.get_attribute_uint32(
            Gio.FILE_ATTRIBUTE_UNIX_MODE);
        const new_mode = (mode | 0o111);
        if (mode === new_mode)
            return true;

        return file.set_attribute_uint32(
            Gio.FILE_ATTRIBUTE_UNIX_MODE,
            new_mode,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);
    } catch (e) {
        logError(e, 'GSConnect');
        return false;
    }
}

/**
 * Ensure critical files in the extension directory have the
 * correct permissions.
 */
export function ensurePermissions() {
    if (Config.IS_USER) {
        const executableFiles = [
            'gsconnect-preferences',
            'service/daemon.js',
            'service/nativeMessagingHost.js',
        ];
        for (const file of executableFiles)
            _setExecutable(GLib.build_filenamev([Config.PACKAGE_DATADIR, file]));
    }
}

/**
 * Install the files necessary for the GSConnect service to run.
 */
export function installService() {
    const settings = new Gio.Settings({
        settings_schema: Config.GSCHEMA.lookup(
            'org.gnome.Shell.Extensions.GSConnect',
            null
        ),
        path: '/org/gnome/shell/extensions/gsconnect/',
    });

    const confDir = GLib.get_user_config_dir();
    const dataDir = GLib.get_user_data_dir();
    const homeDir = GLib.get_home_dir();

    // DBus Service
    const dbusDir = GLib.build_filenamev([dataDir, 'dbus-1', 'services']);
    const dbusFile = `${Config.APP_ID}.service`;

    // Desktop Entry
    const appDir = GLib.build_filenamev([dataDir, 'applications']);
    const appFile = `${Config.APP_ID}.desktop`;
    const appPrefsFile = `${Config.APP_ID}.Preferences.desktop`;

    // Application Icon
    const iconDir = GLib.build_filenamev([dataDir, 'icons', 'hicolor', 'scalable', 'apps']);
    const iconFull = `${Config.APP_ID}.svg`;
    const iconSym = `${Config.APP_ID}-symbolic.svg`;

    // File Manager Extensions
    const fileManagers = [
        [`${dataDir}/nautilus-python/extensions`, 'nautilus-gsconnect.py'],
        [`${dataDir}/nemo-python/extensions`, 'nemo-gsconnect.py'],
    ];

    // WebExtension Manifests
    const manifestFile = 'org.gnome.shell.extensions.gsconnect.json';
    const google = getResource(`webextension/${manifestFile}.google.in`);
    const mozilla = getResource(`webextension/${manifestFile}.mozilla.in`);
    const manifests = [
        [`${confDir}/chromium/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome-beta/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome-unstable/NativeMessagingHosts/`, google],
        [`${confDir}/BraveSoftware/Brave-Browser/NativeMessagingHosts/`, google],
        [`${confDir}/BraveSoftware/Brave-Browser-Beta/NativeMessagingHosts/`, google],
        [`${confDir}/BraveSoftware/Brave-Browser-Nightly/NativeMessagingHosts/`, google],
        [`${homeDir}/.mozilla/native-messaging-hosts/`, mozilla],
        [`${homeDir}/.config/microsoft-edge-dev/NativeMessagingHosts`, google],
        [`${homeDir}/.config/microsoft-edge-beta/NativeMessagingHosts`, google],
    ];

    // If running as a user extension, ensure the DBus service, desktop entry,
    // file manager scripts, and WebExtension manifests are installed.
    if (Config.IS_USER) {
        // DBus Service
        if (!_installResource(dbusDir, dbusFile, `${dbusFile}.in`))
            throw Error('GSConnect: Failed to install DBus Service');

        // Desktop Entries
        _installResource(appDir, appFile, appFile);
        _installResource(appDir, appPrefsFile, appPrefsFile);

        // Application Icon
        _installResource(iconDir, iconFull, `icons/${iconFull}`);
        _installResource(iconDir, iconSym, `icons/${iconSym}`);

        // File Manager Extensions
        const target = `${Config.PACKAGE_DATADIR}/nautilus-gsconnect.py`;

        for (const [dir, name] of fileManagers) {
            const script = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));

            if (!script.query_exists(null)) {
                GLib.mkdir_with_parents(dir, 0o755);
                script.make_symbolic_link(target, null);
            }
        }

        // WebExtension Manifests
        if (settings.get_boolean('create-native-messaging-hosts')) {
            for (const [dirname, contents] of manifests)
                _installFile(dirname, manifestFile, contents);
        }

        // Otherwise, if running as a system extension, ensure anything previously
        // installed when running as a user extension is removed.
    } else {
        GLib.unlink(GLib.build_filenamev([dbusDir, dbusFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appPrefsFile]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconFull]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconSym]));

        for (const [dir, name] of fileManagers)
            GLib.unlink(GLib.build_filenamev([dir, name]));

        for (const manifest of manifests)
            GLib.unlink(GLib.build_filenamev([manifest[0], manifestFile]));
    }
}

/**
 * Initialise and setup Config, GResources and GSchema.
 *
 * @param {string} extensionPath - The absolute path to the extension directory
 */
export function setup(extensionPath) {
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
