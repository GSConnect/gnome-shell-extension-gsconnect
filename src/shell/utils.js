'use strict';

const ByteArray = imports.byteArray;

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Config = Extension.imports.config;


/**
 * Get a themed icon, using fallbacks from GSConnect's GResource when necessary.
 *
 * @param {string} name - A themed icon name
 * @return {Gio.Icon} A themed icon
 */
function getIcon(name) {
    if (getIcon._resource === undefined) {
        // Setup the desktop icons
        const settings = imports.gi.St.Settings.get();
        getIcon._desktop = new imports.gi.Gtk.IconTheme();
        getIcon._desktop.set_custom_theme(settings.gtk_icon_theme);
        settings.connect('notify::gtk-icon-theme', (settings_, key_) => {
            getIcon._desktop.set_custom_theme(settings_.gtk_icon_theme);
        });

        // Preload our fallbacks
        const iconPath = 'resource://org/gnome/Shell/Extensions/GSConnect/icons';
        const iconNames = [
            'org.gnome.Shell.Extensions.GSConnect',
            'org.gnome.Shell.Extensions.GSConnect-symbolic',
            'computer-symbolic',
            'laptop-symbolic',
            'smartphone-symbolic',
            'tablet-symbolic',
            'tv-symbolic',
            'phonelink-ring-symbolic',
            'sms-symbolic',
        ];

        getIcon._resource = {};

        for (const iconName of iconNames) {
            getIcon._resource[iconName] = new Gio.FileIcon({
                file: Gio.File.new_for_uri(`${iconPath}/${iconName}.svg`),
            });
        }
    }

    // Check the desktop icon theme
    if (getIcon._desktop.has_icon(name))
        return new Gio.ThemedIcon({name: name});

    // Check our GResource
    if (getIcon._resource[name] !== undefined)
        return getIcon._resource[name];

    // Fallback to hoping it's in the theme somewhere
    return new Gio.ThemedIcon({name: name});
}


/**
 * Get the contents of a GResource file, replacing `@PACKAGE_DATADIR@` where
 * necessary.
 *
 * @param {string} relativePath - A path relative to GSConnect's resource path
 * @return {string} The file contents as a string
 */
function getResource(relativePath) {
    try {
        const bytes = Gio.resources_lookup_data(
            GLib.build_filenamev([Config.APP_PATH, relativePath]),
            Gio.ResourceLookupFlags.NONE
        );

        const source = ByteArray.toString(bytes.toArray());

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
 * @return {boolean} A success boolean
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
 * @return {boolean} A success boolean
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
 * Install the files necessary for the GSConnect service to run.
 */
function installService() {
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
        for (const [dirname, contents] of manifests)
            _installFile(dirname, manifestFile, contents);

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

