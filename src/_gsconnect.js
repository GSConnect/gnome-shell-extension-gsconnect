'use strict';

const Format = imports.format;
const Gettext = imports.gettext;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;


/**
 * Application Variables
 * TODO: these should mirror package.js
 */
gsconnect.app_id = 'org.gnome.Shell.Extensions.GSConnect';
gsconnect.app_path = '/org/gnome/Shell/Extensions/GSConnect';
gsconnect.is_local = gsconnect.extdatadir.startsWith(GLib.get_user_data_dir());
gsconnect.metadata = JSON.parse(GLib.file_get_contents(gsconnect.extdatadir + '/metadata.json')[1]);


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
 * Setup global object for user or system install
 */
if (gsconnect.is_local) {
    gsconnect.libdir = GIRepository.Repository.get_search_path().find(path => {
        return path.endsWith('/gjs/girepository-1.0');
    }).replace('/gjs/girepository-1.0', '');

    gsconnect.localedir = GLib.build_filenamev([
        gsconnect.extdatadir,
        'locale'
    ]);
    gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([gsconnect.extdatadir, 'schemas']),
        Gio.SettingsSchemaSource.get_default(),
        false
    );
} else {
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
 * If we aren't inside the Gnome Shell process we'll set gettext functions on
 * the global object, otherwise we'll set them on the global 'gsconnect' object
 */
Gettext.bindtextdomain(gsconnect.app_id, gsconnect.localedir);
Gettext.textdomain(gsconnect.app_id);

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
 */
gsconnect.settings = new Gio.Settings({
    settings_schema: gsconnect.gschema.lookup(gsconnect.app_id, true)
});


/**
 * Register resources
 * TODO: these should mirror package.js
 */
gsconnect.resource = Gio.Resource.load(
    GLib.build_filenamev([gsconnect.extdatadir, `${gsconnect.app_id}.gresource`])
);
gsconnect.resource._register();
gsconnect.get_resource = function(path) {
    return Gio.resources_lookup_data(
        GLib.build_filenamev([gsconnect.app_path, path]),
        Gio.ResourceLookupFlags.NONE
    ).toArray().toString().replace('@EXTDATADIR@', gsconnect.extdatadir);
};

/**
 * DBus Interface Introspection
 */
gsconnect.dbusinfo = new Gio.DBusNodeInfo.new_for_xml(
    gsconnect.get_resource(`${gsconnect.app_id}.xml`)
);
gsconnect.dbusinfo.nodes.forEach(info => info.cache_build());


/**
 * If 'debug' is enabled in GSettings, Print a message to the log, prepended
 * with the UUID of the extension.
 *
 * @param {string} msg - the debugging message
 * @param {string} [prefix] - An optional prefix for the message
 */
gsconnect.settings.connect('changed::debug', () => {
    if (gsconnect.settings.get_boolean('debug')) {
        window.debug = function(msg, prefix=null) {
            // Stack regexp
            let _dbgRegexp = /(?:(?:[^<.]+<\.)?([^@]+))?@(.+):(\d+):\d+/g;

            // Grab the second line of a stack trace
            let trace = ((msg.stack) ? msg : new Error()).stack.split('\n')[1];
            let [m, func, file, line] = _dbgRegexp.exec(trace);
            file = GLib.path_get_basename(file);

            // There's a better way...
            let hdr = [file, func, line].filter(k => (k)).join(':');

            // Ensure @msg is a string
            if (msg.stack) {
                msg = `${msg.message}\n${msg.stack}`;
            } else if (typeof msg !== 'string') {
                msg = JSON.stringify(msg, null, 2);
            }

            // Append a prefix for context
            if (prefix !== null) {
                msg = `${prefix}: ${msg}`;
            }

            GLib.log_structured(
                'gsconnect',
                GLib.LogLevelFlags.LEVEL_MESSAGE,
                {
                    CODE_FILE: file,
                    CODE_FUNC: `${func}`,
                    CODE_LINE: `${line}`,
                    MESSAGE: `DEBUG: [${hdr}]: ${msg}`
                }
            );
        };
    } else {
        window.debug = function() {};
    }
});
gsconnect.settings.emit('changed::debug', 'debug');


/**
 * A simple warning function along the lines of logError()
 *
 * @param {Error|string} message - A string or Error to log
 * @param {string} [prefix] - An optional prefix for the warning
 */
window.logWarning = function(message, prefix=null) {
    if (message.hasOwnProperty('message')) {
        message = message.message;
    }

    if (prefix !== null) {
        message = `${prefix}: ${message}`
    }

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


/**
 * Install desktop files for user installs
 */
gsconnect.installService = function() {
    let confDir = GLib.get_user_config_dir();
    let dataDir = GLib.get_user_data_dir();
    let homeDir = GLib.get_home_dir();

    // DBus Service
    let dbusDir = GLib.build_filenamev([dataDir, 'dbus-1', 'services']);
    let dbusFile = `${gsconnect.app_id}.service`;

    // Desktop Entry
    let desktopDir = GLib.build_filenamev([dataDir, 'applications']);
    let desktopFile = `${gsconnect.app_id}.desktop`;

    // Nautilus Extension
    let nautDir = GLib.build_filenamev([dataDir, 'nautilus-python/extensions']);
    let nautScript = GLib.build_filenamev([nautDir, 'nautilus-gsconnect.py']);

    // WebExtension Manifests
    let manifestFile = 'org.gnome.shell.extensions.gsconnect.json';
    let chrome = gsconnect.get_resource(`${manifestFile}-chrome`);
    let mozilla = gsconnect.get_resource(`${manifestFile}-mozilla`);
    let manifests = [
        [confDir + '/chromium/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome-beta/NativeMessagingHosts/', chrome],
        [confDir + '/google-chrome-unstable/NativeMessagingHosts/', chrome],
        [homeDir + '/.mozilla/native-messaging-hosts/', mozilla]
    ];

    // If running as a user extension, ensure the DBus service, desktop entry,
    // Nautilus script and WebExtension manifests are installed.
    if (gsconnect.is_local) {
        // DBus Service
        GLib.mkdir_with_parents(dbusDir, 493);
        GLib.file_set_contents(
            GLib.build_filenamev([dbusDir, dbusFile]),
            gsconnect.get_resource(dbusFile)
        );

        // Desktop Entry
        GLib.mkdir_with_parents(desktopDir, 493);
        GLib.file_set_contents(
            GLib.build_filenamev([desktopDir, desktopFile]),
            gsconnect.get_resource(desktopFile)
        );

        // Nautilus Extension
        let script = Gio.File.new_for_path(nautScript);

        if (!script.query_exists(null)) {
            GLib.mkdir_with_parents(nautDir, 493); // 0755 in octal

            script.make_symbolic_link(
                gsconnect.extdatadir + '/nautilus-gsconnect.py',
                null
            );
        }

        // WebExtension Manifests
        for (let [dir, manifest] of manifests) {
            GLib.mkdir_with_parents(dir, 493);
            GLib.file_set_contents(
                GLib.build_filenamev([dir, manifestFile]),
                manifest
            );
        }

    // Otherwise, if running as a system extension, ensure anything previously
    // installed when running as a user extension is removed.
    } else {
        GLib.unlink(GLib.build_filenamev([dbusDir, dbusFile]));
        GLib.unlink(GLib.build_filenamev([desktopDir, desktopFile]));
        GLib.unlink(nautScript);

        for (let [dir, obj] of manifests) {
            GLib.unlink(GLib.build_filenamev([dir, manifestFile]));
        }
    }
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
 * A convenience function for connecting template callbacks
 */
Gtk.Widget.prototype.connect_template = function() {
    this.$templateHandlers = [];

    Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
        this.$templateHandlers.push([
            obj,
            obj.connect(signalName, this[handlerName].bind(this))
        ]);
    });
};


/**
 * A convenience function for disconnecting template callbacks
 */
Gtk.Widget.prototype.disconnect_template = function() {
    Gtk.Widget.set_connect_func.call(this, function(){});
    this.$templateHandlers.map(([obj, id]) => obj.disconnect(id));
};


/**
 * String.format API supporting %s, %d, %x and %f
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = Format.format;

