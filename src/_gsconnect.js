'use strict';

const ByteArray = imports.byteArray;

const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;


// Bootstrap the global object
if (!globalThis.gsconnect) {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);

    globalThis.gsconnect = {
        extdatadir: Gio.File.new_for_path(m[1]).get_parent().get_path()
    };
}


/**
 * String.format API supporting %s, %d, %x and %f. Used exclusively for gettext.
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = imports.format.format;


/**
 * Application Variables
 */
gsconnect.app_id = 'org.gnome.Shell.Extensions.GSConnect';
gsconnect.app_path = '/org/gnome/Shell/Extensions/GSConnect';
gsconnect.is_local = gsconnect.extdatadir.startsWith(GLib.get_user_data_dir());
gsconnect.metadata = (() => {
    let data = GLib.file_get_contents(gsconnect.extdatadir + '/metadata.json')[1];

    return JSON.parse(imports.byteArray.toString(data));
})();


/**
 * User Directories
 */
gsconnect.cachedir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gsconnect']);
gsconnect.configdir = GLib.build_filenamev([GLib.get_user_config_dir(), 'gsconnect']);
gsconnect.runtimedir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gsconnect']);

for (let path of [gsconnect.cachedir, gsconnect.configdir, gsconnect.runtimedir]) {
    GLib.mkdir_with_parents(path, 0o755);
}


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
    // These should be populated by meson for this system at build time
    gsconnect.libdir = gsconnect.metadata.libdir;
    gsconnect.localedir = gsconnect.metadata.localedir;
    gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
        gsconnect.metadata.gschemadir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
}


/**
 * Init Gettext
 *
 * If we aren't inside the GNOME Shell process we'll set gettext functions on
 * the global object, otherwise we'll set them on the global 'gsconnect' object
 */
imports.gettext.bindtextdomain(gsconnect.app_id, gsconnect.localedir);
const Gettext = imports.gettext.domain(gsconnect.app_id);

if (typeof _ !== 'function') {
    globalThis._ = Gettext.gettext;
    globalThis.ngettext = Gettext.ngettext;
} else {
    gsconnect._ = Gettext.gettext;
    gsconnect.ngettext = Gettext.ngettext;
}


/**
 * Init GSettings
 */
gsconnect.settings = new Gio.Settings({
    settings_schema: gsconnect.gschema.lookup(gsconnect.app_id, true)
});


/**
 * Register resources
 */
Gio.Resource.load(
    GLib.build_filenamev([gsconnect.extdatadir, `${gsconnect.app_id}.gresource`])
)._register();

gsconnect.get_resource = function(rel_path) {
    let array = Gio.resources_lookup_data(
        GLib.build_filenamev([gsconnect.app_path, rel_path]),
        Gio.ResourceLookupFlags.NONE
    ).toArray();

    array = imports.byteArray.toString(array);

    return array.replace('@EXTDATADIR@', gsconnect.extdatadir);
};


/**
 * DBus Interface Introspection
 */
gsconnect.dbusinfo = Gio.DBusNodeInfo.new_for_xml(
    gsconnect.get_resource(`${gsconnect.app_id}.xml`)
);
gsconnect.dbusinfo.nodes.forEach(info => info.cache_build());


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
            GLib.build_filenamev([gsconnect.app_path, rel_path]),
            Gio.ResourceLookupFlags.NONE
        );

        let source = ByteArray.toString(bytes.toArray());
        let contents = source.replace('@EXTDATADIR@', gsconnect.extdatadir);

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
    let dbusFile = `${gsconnect.app_id}.service`;

    // Desktop Entry
    let appDir = GLib.build_filenamev([dataDir, 'applications']);
    let appFile = `${gsconnect.app_id}.desktop`;
    let appPrefsFile = `${gsconnect.app_id}.Preferences.desktop`;

    // Application Icon
    let iconDir = GLib.build_filenamev([dataDir, 'icons', 'hicolor', 'scalable', 'apps']);
    let iconFull = `${gsconnect.app_id}.svg`;
    let iconSym = `${gsconnect.app_id}-symbolic.svg`;

    // File Manager Extensions
    let fileManagers = [
        [dataDir + '/nautilus-python/extensions', 'nautilus-gsconnect.py'],
        [dataDir + '/nemo-python/extensions', 'nemo-gsconnect.py']
    ];

    // WebExtension Manifests
    let manifestFile = 'org.gnome.shell.extensions.gsconnect.json';
    let chrome = gsconnect.get_resource(`${manifestFile}-chrome`);
    let mozilla = gsconnect.get_resource(`${manifestFile}-mozilla`);
    let manifests = [
        [confDir + '/chromium/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome-beta/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome-unstable/NativeMessagingHosts/', chrome],
        [confDir + '/BraveSoftware/Brave-Browser/NativeMessagingHosts/', chrome],
        [homeDir + '/.mozilla/native-messaging-hosts/', mozilla]
    ];

    // If running as a user extension, ensure the DBus service, desktop entry,
    // file manager scripts, and WebExtension manifests are installed.
    if (gsconnect.is_local) {
        // DBus Service
        if (!installResource(dbusDir, dbusFile, dbusFile))
            throw Error('GSConnect: Failed to install DBus Service');

        // Desktop Entries
        installResource(appDir, appFile, appFile);
        installResource(appDir, appPrefsFile, appPrefsFile);

        // Application Icon
        installResource(iconDir, iconFull, `icons/${iconFull}`);
        installResource(iconDir, iconSym, `icons/${iconSym}`);

        // File Manager Extensions
        for (let [dir, name] of fileManagers) {
            let script = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
            if (!script.query_exists(null)) {
                GLib.mkdir_with_parents(dir, 0o755);
                script.make_symbolic_link(
                    gsconnect.extdatadir + '/nautilus-gsconnect.py',
                    null
                );
            }
        }

        // WebExtension Manifests
        for (let [dirname, contents] of manifests) {
            installFile(dirname, manifestFile, contents);
        }

    // Otherwise, if running as a system extension, ensure anything previously
    // installed when running as a user extension is removed.
    } else {
        GLib.unlink(GLib.build_filenamev([dbusDir, dbusFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appFile]));
        GLib.unlink(GLib.build_filenamev([appDir, appPrefsFile]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconFull]));
        GLib.unlink(GLib.build_filenamev([iconDir, iconSym]));

        for (let [dir, name] of fileManagers) {
            GLib.unlink(GLib.build_filenamev([dir, name]));
        }

        for (let dir of Object.keys(manifests)) {
            GLib.unlink(GLib.build_filenamev([dir, manifestFile]));
        }
    }
};
