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
        window.debug = function (msg) {
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
        window.debug = function () { return; };
    }
});
gsconnect.settings.emit('changed::debug', 'debug');


/**
 * Check if a command is in the PATH
 * @param {string} name - the name of the command
 */
gsconnect.checkCommand = function(cmd) {
    let proc = GLib.spawn_async_with_pipes(
        null,                           // working dir
        ['which', cmd],                // argv
        null,                           // envp
        GLib.SpawnFlags.SEARCH_PATH,    // enables PATH
        null                            // child_setup (func)
    );

    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let [result, length] = stdout.read_line(null);
    stdout.close(null);

    return (result !== null);
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

    // sms:// scheme handler
    let appInfo = Gio.DesktopAppInfo.new_from_filename(
        applicationsDir + desktopFile
    );
    appInfo.add_supports_type('x-scheme-handler/sms');
    appInfo.add_supports_type('x-scheme-handler/tel');
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
    } else if (typeof obj.map === 'function') {
        return GLib.Variant.new('av', obj.map(i => gsconnect.full_pack(i)));
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
    if (typeof obj.deep_unpack === 'function') {
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
 * See: https://bugzilla.gnome.org/show_bug.cgi?id=788315
 *
 * @return {string} - A SHA1 fingerprint of the certificate.
 */
Gio.TlsCertificate.prototype.fingerprint = function() {
    if (!this.__fingerprint) {
        let proc = GLib.spawn_async_with_pipes(
            null,
            ['openssl', 'x509', '-noout', '-fingerprint', '-sha1', '-inform', 'pem'],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );

        let stdin = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({ fd: proc[2] })
        });
        stdin.put_string(this.certificate_pem, null);
        stdin.close(null);

        let stdout = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: proc[3] })
        });
        this.__fingerprint = stdout.read_line(null)[0].toString().split('=')[1];
        stdout.close(null);
    }

    return this.__fingerprint;
};


/**
 * Extend Gio.TlsCertificate with a property holding the serial number of the
 * certificate.
 */
Object.defineProperty(Gio.TlsCertificate.prototype, 'serial', {
    get: function() {
        if (!this.__serial) {
            let proc = GLib.spawn_async_with_pipes(
                null,
                ['openssl', 'x509', '-noout', '-serial', '-inform', 'pem'],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            let stdin = new Gio.DataOutputStream({
                base_stream: new Gio.UnixOutputStream({ fd: proc[2] })
            });
            stdin.put_string(this.certificate_pem, null);
            stdin.close(null);

            let stdout = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: proc[3] })
            });
            this.__serial = stdout.read_line(null)[0].toString().split('=')[1];
            stdout.close(null);
        }

        return this.__serial;
    },
    enumerable: true
});


/**
 * String.format API supporting %s, %d, %x and %f
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = Format.format;


/**
 * String tranformation prototypes
 */
String.prototype.toDBusSafe = function(string) {
    string = string || this;
    return string.replace(/[^A-Za-z0-9_]+/g, '_');
};


String.prototype.toGSettingsSafe = function(string) {
    string = string || this;
    return string.replace(/[^a-z0-9-]+/g, '_');
};


String.prototype.toCamelCase = function(string) {
    string = string || this;

    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return (offset === 0) ? ltr.toLowerCase() : ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
};


String.prototype.toHyphenCase = function(string) {
    string = string || this;

	return string.replace(/(?:[A-Z])/g, (ltr, offset) => {
        return (offset > 0) ? '-' + ltr.toLowerCase() : ltr.toLowerCase();
	}).replace(/[\s_]+/g, '');
};


String.prototype.toUnderscoreCase = function(string) {
    string = string || this;

	return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
	    if (ltr === '_') return '';
        return (offset > 0) ? '_' + ltr.toLowerCase() : ltr.toLowerCase();
	}).replace(/[\s-]+/g, '');
};

