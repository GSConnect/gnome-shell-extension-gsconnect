'use strict';

const Format = imports.format;
const Gettext = imports.gettext;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;


/**
 * Determing if GSConnect is installed as a user extension
 */
gsconnect.is_local = gsconnect.datadir.startsWith(GLib.get_user_data_dir());


/**
 * Application Id and Path
 * TODO: these should mirror package.js
 */
gsconnect.app_id = 'org.gnome.Shell.Extensions.GSConnect';
gsconnect.app_path = '/org/gnome/Shell/Extensions/GSConnect';
gsconnect.metadata = JSON.parse(GLib.file_get_contents(gsconnect.datadir + '/metadata.json')[1]);


/**
 * User Directories
 * TODO: these should mirror package.js
 */
gsconnect.cachedir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gsconnect']);
gsconnect.configdir = GLib.build_filenamev([GLib.get_user_config_dir(), 'gsconnect']);
gsconnect.runtimedir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gsconnect']);

for (let path of [gsconnect.cachedir, gsconnect.configdir, gsconnect.runtimedir]) {
    GLib.mkdir_with_parents(path, 448);
}

/**
 * Gettext
 * TODO: these should mirror package.js
 */
gsconnect.localedir = GLib.build_filenamev([gsconnect.datadir, 'locale']);

Gettext.bindtextdomain(gsconnect.app_id, gsconnect.localedir);
Gettext.textdomain(gsconnect.app_id);

// If we aren't inside the Gnome Shell process, set gettext on the global,
// otherwise we'll set in on the global 'gsconnect' object
if (typeof _ !== 'function') {
    window._ = Gettext.gettext;
    window.ngettext = Gettext.ngettext;
    window.N_ = function (s) { return s; };
    window.C_ = Gettext.pgettext;
} else {
    gsconnect._ = Gettext.gettext;
    gsconnect.ngettext = Gettext.ngettext;
    gsconnect.N_ = function (s) { return s; };
    gsconnect.C_ = Gettext.pgettext;
}


/**
 * Init GSettings
 * TODO: these should mirror package.js
 */
gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([gsconnect.datadir, 'schemas']),
    Gio.SettingsSchemaSource.get_default(),
    false
);

gsconnect.settings = new Gio.Settings({
    settings_schema: gsconnect.gschema.lookup(gsconnect.app_id, true)
});


/**
 * Register resources
 * TODO: these should mirror package.js
 */
gsconnect.resource = Gio.Resource.load(
    GLib.build_filenamev([gsconnect.datadir, gsconnect.app_id + '.data.gresource'])
);
gsconnect.resource._register();


/**
 * DBus Interface Introspection
 */
gsconnect.dbusinfo = new Gio.DBusNodeInfo.new_for_xml(
    Gio.resources_lookup_data(
        gsconnect.app_path + '/' + gsconnect.app_id + '.xml',
        Gio.ResourceLookupFlags.NONE
    ).toArray().toString()
);
gsconnect.dbusinfo.nodes.forEach(info => info.cache_build());


/**
 * If 'debug' is enabled in GSettings, Print a message to the log, prepended
 * with the UUID of the extension.
 * @param {String} msg - the debugging message
 */
gsconnect.settings.connect('changed::debug', () => {
    if (gsconnect.settings.get_boolean('debug')) {
        window.debug = function(msg) {
            // Stack regexp
            let _dbgRegexp = /(?:(?:([^<.]+)<\.)?([^@]+))?@(.+):(\d+):\d+/g;
            let e = (msg.stack) ? msg : new Error();
            let [m, k, f, fn, l] = _dbgRegexp.exec(e.stack.split('\n')[1]);
            fn = GLib.path_get_basename(fn);

            // There's a better way...
            let hdr = [gsconnect.metadata.name, fn, k, f, l].filter(k => (k)).join(':');

            // fix msg if not string
            if (msg.stack) {
                msg = `${msg.message}\n${msg.stack}`;
            } else if (typeof msg !== 'string') {
                msg = JSON.stringify(msg, null, 2);
            }

            log(`[${hdr}]: ${msg}`);
        };
    } else {
        window.debug = function() {};
    }
});
gsconnect.settings.emit('changed::debug', 'debug');

window.warning = function(message) {
    GLib.log_structured(
        'gsconnect',
        GLib.LogLevelFlags.LEVEL_WARNING,
        { MESSAGE: `WARNING: ${message}` }
    );
};


/**
 * Check if a command is in the PATH
 * @param {string} name - the name of the command
 */
gsconnect.hasCommand = function(cmd) {
    let proc = new Gio.Subprocess({
        argv: ['which', cmd],
        flags: Gio.SubprocessFlags.STDOUT_PIPE
    });
    proc.init(null);

    let stdout = proc.communicate_utf8(null, null)[1];
    proc.force_exit();
    proc.wait(null);

    return (stdout.length);
};


function installWebExtensionManifests() {
    let nmhPath = gsconnect.datadir + '/service/nativeMessagingHost.js';

    let google = {
        'name': 'org.gnome.shell.extensions.gsconnect',
        'description': 'Native messaging host for GSConnect WebExtension',
        'path': nmhPath,
        'type': 'stdio',
        'allowed_origins': [ 'chrome-extension://jfnifeihccihocjbfcfhicmmgpjicaec/' ]
    };

    let mozilla = {
        'name': 'org.gnome.shell.extensions.gsconnect',
        'description': 'Native messaging host for GSConnect WebExtension',
        'path': nmhPath,
        'type': 'stdio',
        'allowed_extensions': [ 'gsconnect@andyholmes.github.io' ]
    };

    let basename = 'org.gnome.shell.extensions.gsconnect.json';
    let userConfDir = GLib.get_user_config_dir();
    let browsers = [
        [userConfDir + '/chromium/NativeMessagingHosts/', google],
        [userConfDir + '/google-chrome/NativeMessagingHosts/', google],
        [userConfDir + '/google-chrome-beta/NativeMessagingHosts/', google],
        [userConfDir + '/google-chrome-unstable/NativeMessagingHosts/', google],
        [GLib.get_home_dir() + '/.mozilla/native-messaging-hosts/', mozilla]
    ];

    for (let browser of browsers) {
        GLib.mkdir_with_parents(browser[0], 493);
        GLib.file_set_contents(
            browser[0] + basename,
            JSON.stringify(browser[1])
        );
    }

    GLib.spawn_command_line_async(`chmod 0755 ${nmhPath}`);
}


/**
 * Install/Uninstall desktop files for user installs
 *     - XDG .desktop file
 *     - DBus .service file
 *     - Register sms:// scheme handler
 */
gsconnect.installService = function() {
    // Skip if installed as a system extension
    if (!gsconnect.is_local) {
        return;
    }

    // Nautilus Extension
    let path = GLib.get_user_data_dir() + '/nautilus-python/extensions';
    let script = Gio.File.new_for_path(path).get_child('nautilus-gsconnect.py');

    if (!script.query_exists(null)) {
        GLib.mkdir_with_parents(path, 493); // 0755 in octal

        script.make_symbolic_link(
            gsconnect.datadir + '/nautilus-gsconnect.py',
            null
        );
    }

    // Web Extension
    installWebExtensionManifests();

    // Ensure daemon.js is executable

    // systemd service file
    let systemdDir = GLib.get_user_data_dir() + '/systemd/user/';
    let systemdFile = gsconnect.app_id + '.service';
    let systemdBytes = Gio.resources_lookup_data(
        gsconnect.app_path + '/' + systemdFile + '-systemd', 0
    ).toArray().toString().replace('@DATADIR@', gsconnect.datadir);

    GLib.mkdir_with_parents(systemdDir, 493);
    GLib.file_set_contents(systemdDir + systemdFile, systemdBytes);
    GLib.spawn_command_line_async('systemctl --user daemon-reload');

    // DBus service file
    let dbusDir = GLib.get_user_data_dir() + '/dbus-1/services/';
    let dbusFile = gsconnect.app_id + '.service';
    let dbusBytes = Gio.resources_lookup_data(
        gsconnect.app_path + '/' + dbusFile + '-dbus', 0
    ).toArray().toString().replace('@DATADIR@', gsconnect.datadir);

    GLib.mkdir_with_parents(dbusDir, 493);
    GLib.file_set_contents(dbusDir + dbusFile, dbusBytes);

    // Application desktop file
    let applicationsDir = GLib.get_user_data_dir() + '/applications/';
    let desktopFile = gsconnect.app_id + '.desktop';
    let desktopBytes = Gio.resources_lookup_data(
        gsconnect.app_path + '/' + desktopFile, 0
    ).toArray().toString().replace('@DATADIR@', gsconnect.datadir);

    GLib.mkdir_with_parents(applicationsDir, 493);
    GLib.file_set_contents(applicationsDir + desktopFile, desktopBytes);
};


/**
 * Recursively pack a GLib.Variant from a JSON-compatible object
 */
gsconnect.full_pack = function(obj) {
    if (obj instanceof GLib.Variant) {
        return obj;
    } else if (typeof obj === 'string') {
        return GLib.Variant.new('s', obj);
    } else if (typeof obj === 'number') {
        return GLib.Variant.new('d', obj);
    } else if (typeof obj === 'boolean') {
        return GLib.Variant.new('b', obj);
    } else if (obj === null) {
        return GLib.Variant.new('mv', null);
    } else if (typeof obj.map === 'function') {
        return GLib.Variant.new('av', obj.map(i => gsconnect.full_pack(i)));
    } else if (obj instanceof Gio.Icon) {
        return obj.serialize();
    } else if (typeof obj === 'object' && typeof obj !== null) {
        let packed = {};

        for (let key in obj) {
            packed[key] = gsconnect.full_pack(obj[key]);
        }

        return GLib.Variant.new('a{sv}', packed);
    }

    return null;
};


/**
 * Recursively deep_unpack() a GLib.Variant
 */
gsconnect.full_unpack = function(obj) {
    if (obj === null) {
        return obj;
    } else if (typeof obj.deep_unpack === 'function') {
        return gsconnect.full_unpack(obj.deep_unpack());
    } else if (typeof obj.map === 'function') {
        return obj.map(i => gsconnect.full_unpack(i));
    } else if (typeof obj === 'object' && typeof obj !== null) {
        let unpacked = {};

        for (let key in obj) {
            unpacked[key] = gsconnect.full_unpack(obj[key]);
        }

        return unpacked;
    }

    return obj;
};


/**
 * Extend Gio.Settings with an implementation of bind_with_mapping()
 */
Gio.Settings.prototype.bind_with_mapping = function(key, object, property, flags=0, get_mapping, set_mapping) {
    if ((flags & Gio.SettingsBindFlags.GET) || flags === 0) {
        let _getChanged = this.connect(
            `changed::${key}`,
            () => get_mapping(this.get_value(key))
        );
        object.connect('destroy', () => this.disconnect(_getChanged));
    }

    if ((flags & Gio.SettingsBindFlags.SET) || flags === 0) {
        let _setChanged = object.connect(
            `notify::${property}`,
            () => set_mapping(object[property])
        );
        object.connect('destroy', (obj) => obj.disconnect(_setChanged));
    }
};


/**
 * Extend Gio.TlsCertificate with a method for computing a SHA1 fingerprint.
 * See: https://gitlab.gnome.org/GNOME/glib/issues/1290
 *
 * @return {string} - A SHA1 fingerprint of the certificate.
 */
Gio.TlsCertificate.prototype.fingerprint = function() {
    if (!this.__fingerprint) {
        let proc = new Gio.Subprocess({
            argv: ['openssl', 'x509', '-noout', '-fingerprint', '-sha1', '-inform', 'pem'],
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
        });
        proc.init(null);

        let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
        this.__fingerprint = /[a-zA-Z0-9\:]{59}/.exec(stdout)[0];

        proc.force_exit();
        proc.wait(null);
    }

    return this.__fingerprint;
};


/**
 * Extend Gio.TlsCertificate with a property holding the common name.
 */
Object.defineProperty(Gio.TlsCertificate.prototype, 'common_name', {
    get: function() {
        if (!this.__common_name) {
            let proc = new Gio.Subprocess({
                argv: ['openssl', 'x509', '-noout', '-subject', '-inform', 'pem'],
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
            });
            proc.init(null);

            let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
            this.__common_name = /[a-zA-Z0-9\-]{36}/.exec(stdout)[0];

            proc.force_exit();
            proc.wait(null);
        }

        return this.__common_name;
    },
    enumerable: true
});


/**
 * String.format API supporting %s, %d, %x and %f
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = Format.format;

