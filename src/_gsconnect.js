'use strict';

const ByteArray = imports.byteArray;
const Gettext = imports.gettext;

const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;

const APP_ID = 'org.gnome.Shell.Extensions.GSConnect';
const APP_PATH = '/org/gnome/Shell/Extensions/GSConnect';


// Bootstrap the global object
if (!globalThis.gsconnect) {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);

    globalThis.gsconnect = {
        extdatadir: Gio.File.new_for_path(m[1]).get_parent().get_path()
    };
}


/**
 * Application Variables
 */
gsconnect.is_local = gsconnect.extdatadir.startsWith(GLib.get_user_data_dir());


/**
 * Setup global object for user or system install
 */
function _findLibdir() {
    // Infer libdir by assuming gnome-shell shares a common prefix with gjs
    let searchPath = GIRepository.Repository.get_search_path();

    let libdir = searchPath.find(path => {
        return path.endsWith('/gjs/girepository-1.0');
    }).replace('/gjs/girepository-1.0', '');

    // Assume the parent directory if it's not there
    let path = GLib.build_filenamev([libdir, 'gnome-shell']);

    if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) {
        let currentDir = `/${GLib.path_get_basename(libdir)}`;
        libdir = libdir.replace(currentDir, '');
    }

    return libdir;
}

if (gsconnect.is_local) {
    // Infer libdir by assuming gnome-shell shares a common prefix with gjs
    gsconnect.libdir = _findLibdir();

    // locale and schemas will be a subdirectories of the extension root
    gsconnect.localedir = GLib.build_filenamev([gsconnect.extdatadir, 'locale']);
    gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([gsconnect.extdatadir, 'schemas']),
        Gio.SettingsSchemaSource.get_default(),
        false
    );
} else {
    const Config = imports.utils.config;

    // These should be populated by meson for this system at build time
    gsconnect.libdir = Config.GNOME_SHELL_LIBDIR;
    gsconnect.localedir = Config.PACKAGE_LOCALEDIR;
    gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
        Config.GSETTINGS_SCHEMA_DIR,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
}


/**
 * Init Gettext
 *
 * If we aren't inside the GNOME Shell process we'll set gettext functions on
 * the global object, otherwise we'll set them on the extension object
 */
Gettext.bindtextdomain(APP_ID, gsconnect.localedir);

if (typeof _ !== 'function') {
    String.prototype.format = imports.format.format;
    globalThis._ = GLib.dgettext.bind(null, APP_ID);
    globalThis.ngettext = GLib.dngettext.bind(null, APP_ID);
} else {
    let Extension = imports.misc.extensionUtils.getCurrentExtension();
    Extension._ = GLib.dgettext.bind(null, APP_ID);
    Extension.ngettext = GLib.dngettext.bind(null, APP_ID);
}


/**
 * Init GSettings
 */
gsconnect.settings = new Gio.Settings({
    settings_schema: gsconnect.gschema.lookup(APP_ID, true)
});


/**
 * Register resources
 */
Gio.Resource.load(
    GLib.build_filenamev([gsconnect.extdatadir, `${APP_ID}.gresource`])
)._register();

gsconnect.get_resource = function(rel_path) {
    let array = Gio.resources_lookup_data(
        GLib.build_filenamev([APP_PATH, rel_path]),
        Gio.ResourceLookupFlags.NONE
    ).toArray();

    array = imports.byteArray.toString(array);

    return array.replace('@PACKAGE_DATADIR@', gsconnect.extdatadir);
};


/**
 * Install desktop files for user installs
 */
function installFile(dirname, basename, contents) {
    try {
        let filename = GLib.build_filenamev([dirname, basename]);
        GLib.mkdir_with_parents(dirname, 0o755);

        return GLib.file_set_contents(filename, contents);
    } catch (e) {
        logError(e, 'GSConnect');

        return false;
    }
}

function installResource(dirname, basename, rel_path) {
    try {
        let bytes = Gio.resources_lookup_data(
            GLib.build_filenamev([APP_PATH, rel_path]),
            Gio.ResourceLookupFlags.NONE
        );

        let source = ByteArray.toString(bytes.toArray());
        let contents = source.replace('@PACKAGE_DATADIR@', gsconnect.extdatadir);

        return installFile(dirname, basename, contents);
    } catch (e) {
        logError(e, 'GSConnect');

        return false;
    }
}

gsconnect.installService = function() {
    let confDir = GLib.get_user_config_dir();
    let dataDir = GLib.get_user_data_dir();
    let homeDir = GLib.get_home_dir();

    // DBus Service
    let dbusDir = GLib.build_filenamev([dataDir, 'dbus-1', 'services']);
    let dbusFile = `${APP_ID}.service`;

    // Desktop Entry
    let appDir = GLib.build_filenamev([dataDir, 'applications']);
    let appFile = `${APP_ID}.desktop`;
    let appPrefsFile = `${APP_ID}.Preferences.desktop`;

    // Application Icon
    let iconDir = GLib.build_filenamev([dataDir, 'icons', 'hicolor', 'scalable', 'apps']);
    let iconFull = `${APP_ID}.svg`;
    let iconSym = `${APP_ID}-symbolic.svg`;

    // File Manager Extensions
    let fileManagers = [
        [`${dataDir}/nautilus-python/extensions`, 'nautilus-gsconnect.py'],
        [`${dataDir}/nemo-python/extensions`, 'nemo-gsconnect.py']
    ];

    // WebExtension Manifests
    let manifestFile = 'org.gnome.shell.extensions.gsconnect.json';
    let google = gsconnect.get_resource(`webextension/${manifestFile}.google.in`);
    let mozilla = gsconnect.get_resource(`webextension/${manifestFile}.mozilla.in`);
    let manifests = [
        [`${confDir}/chromium/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome-beta/NativeMessagingHosts/`, google],
        [`${confDir}/google-chrome-unstable/NativeMessagingHosts/`, google],
        [`${confDir}/BraveSoftware/Brave-Browser/NativeMessagingHosts/`, google],
        [`${homeDir}/.mozilla/native-messaging-hosts/`, mozilla]
    ];

    // If running as a user extension, ensure the DBus service, desktop entry,
    // file manager scripts, and WebExtension manifests are installed.
    if (gsconnect.is_local) {
        // DBus Service
        if (!installResource(dbusDir, dbusFile, `${dbusFile}.in`))
            throw Error('GSConnect: Failed to install DBus Service');

        // Desktop Entries
        installResource(appDir, appFile, appFile);
        installResource(appDir, appPrefsFile, appPrefsFile);

        // Application Icon
        installResource(iconDir, iconFull, `icons/${iconFull}`);
        installResource(iconDir, iconSym, `icons/${iconSym}`);

        // File Manager Extensions
        let target = `${gsconnect.extdatadir}/nautilus-gsconnect.py`;

        for (let [dir, name] of fileManagers) {
            let script = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));

            if (!script.query_exists(null)) {
                GLib.mkdir_with_parents(dir, 0o755);
                script.make_symbolic_link(target, null);
            }
        }

        // WebExtension Manifests
        for (let [dirname, contents] of manifests)
            installFile(dirname, manifestFile, contents);

    // Otherwise, if running as a system extension, ensure anything previously
    // installed when running as a user extension is removed.
    } else {
        GLib.unlink(GLib.build_filenamev([dbusDir, dbusFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appPrefsFile]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconFull]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconSym]));

        for (let [dir, name] of fileManagers)
            GLib.unlink(GLib.build_filenamev([dir, name]));

        for (let manifest of manifests)
            GLib.unlink(GLib.build_filenamev([manifest[0], manifestFile]));
    }
};
