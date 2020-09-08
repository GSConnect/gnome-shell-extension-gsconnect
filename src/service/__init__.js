'use strict';

const ByteArray = imports.byteArray;
const Gettext = imports.gettext;

const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;

const Config = imports.config;


// User Directories
Config.CACHEDIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gsconnect']);
Config.CONFIGDIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'gsconnect']);
Config.RUNTIMEDIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gsconnect']);


// Ensure config.js is setup properly
const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell']);

if (Config.PACKAGE_DATADIR.startsWith(userDir)) {
    Config.IS_USER = true;

    Config.GSETTINGS_SCHEMA_DIR = `${Config.PACKAGE_DATADIR}/schemas`;
    Config.PACKAGE_LOCALEDIR = `${Config.PACKAGE_DATADIR}/locale`;

    // Infer libdir by assuming gnome-shell shares a common prefix with gjs;
    // assume the parent directory if it's not there
    let libdir = GIRepository.Repository.get_search_path().find(path => {
        return path.endsWith('/gjs/girepository-1.0');
    }).replace('/gjs/girepository-1.0', '');

    let gsdir = GLib.build_filenamev([libdir, 'gnome-shell']);

    if (!GLib.file_test(gsdir, GLib.FileTest.IS_DIR)) {
        let currentDir = `/${GLib.path_get_basename(libdir)}`;
        libdir = libdir.replace(currentDir, '');
    }

    Config.GNOME_SHELL_LIBDIR = libdir;
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


// Load DBus interfaces
Config.DBUS = (() => {
    let bytes = Gio.resources_lookup_data(
        GLib.build_filenamev([Config.APP_PATH, `${Config.APP_ID}.xml`]),
        Gio.ResourceLookupFlags.NONE
    );

    let xml = ByteArray.toString(bytes.toArray());
    let dbus = Gio.DBusNodeInfo.new_for_xml(xml);
    dbus.nodes.forEach(info => info.cache_build());

    return dbus;
})();


// Init User Directories
for (let path of [Config.CACHEDIR, Config.CONFIGDIR, Config.RUNTIMEDIR])
    GLib.mkdir_with_parents(path, 0o755);


/**
 * Check if we're in a Wayland session (mostly for input synthesis)
 * https://wiki.gnome.org/Accessibility/Wayland#Bugs.2FIssues_We_Must_Address
 */
globalThis.HAVE_REMOTEINPUT = GLib.getenv('GDMSESSION') !== 'ubuntu-wayland';
globalThis.HAVE_WAYLAND = GLib.getenv('XDG_SESSION_TYPE') === 'wayland';


/**
 * A custom debug function that logs at LEVEL_MESSAGE to avoid the need for env
 * variables to be set.
 *
 * @param {Error|string} message - A string or Error to log
 * @param {string} [prefix] - An optional prefix for the warning
 */
const _debugCallerMatch = new RegExp(/([^@]*)@([^:]*):([^:]*)/);
// eslint-disable-next-line func-style
const _debugFunc = function (error, prefix = null) {
    let caller, message;

    if (error.stack) {
        caller = error.stack.split('\n')[0];
        message = `${error.message}\n${error.stack}`;
    } else {
        caller = (new Error()).stack.split('\n')[1];
        message = JSON.stringify(error, null, 2);
    }

    if (prefix)
        message = `${prefix}: ${message}`;

    let [, func, file, line] = _debugCallerMatch.exec(caller);
    let script = file.replace(Config.PACKAGE_DATADIR, '');

    GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
        'MESSAGE': `[${script}:${func}:${line}]: ${message}`,
        'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect',
        'CODE_FILE': file,
        'CODE_FUNC': func,
        'CODE_LINE': line,
    });
};

// Swap the function out for a no-op anonymous function for speed
const settings = new Gio.Settings({
    settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
});

settings.connect('changed::debug', (settings, key) => {
    globalThis.debug = settings.get_boolean(key) ? _debugFunc : () => {};
});

if (settings.get_boolean('debug'))
    globalThis.debug = _debugFunc;
else
    globalThis.debug = () => {};


/**
 * A simple (for now) pre-comparison sanitizer for phone numbers
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/smsapp/conversationlistmodel.cpp#L200-L210
 *
 * @return {string} Return the string stripped of leading 0, and ' ()-+'
 */
String.prototype.toPhoneNumber = function () {
    let strippedNumber = this.replace(/^0*|[ ()+-]/g, '');

    if (strippedNumber.length)
        return strippedNumber;

    return this;
};


/**
 * A simple equality check for phone numbers based on `toPhoneNumber()`
 *
 * @param {string} number - A phone number string to compare
 * @return {boolean} If `this` and @number are equivalent phone numbers
 */
String.prototype.equalsPhoneNumber = function (number) {
    let a = this.toPhoneNumber();
    let b = number.toPhoneNumber();

    return (a.endsWith(b) || b.endsWith(a));
};


/**
 * An implementation of `rm -rf` in Gio
 *
 * @param {Gio.File|string} file - a GFile or filepath
 */
Gio.File.rm_rf = function (file) {
    try {
        if (typeof file === 'string')
            file = Gio.File.new_for_path(file);

        try {
            let iter = file.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let info;

            while ((info = iter.next_file(null)))
                Gio.File.rm_rf(iter.get_child(info));

            iter.close(null);
        } catch (e) {
            // Silence errors
        }

        file.delete(null);
    } catch (e) {
        // Silence errors
    }
};


/**
 * Extend GLib.Variant with a static method to recursively pack a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 * @return {GLib.Variant} The resulting GVariant
 */
function _full_pack(obj) {
    let packed;
    let type = typeof obj;

    switch (true) {
        case (obj instanceof GLib.Variant):
            return obj;

        case (type === 'string'):
            return GLib.Variant.new('s', obj);

        case (type === 'number'):
            return GLib.Variant.new('d', obj);

        case (type === 'boolean'):
            return GLib.Variant.new('b', obj);

        case (obj instanceof Uint8Array):
            return GLib.Variant.new('ay', obj);

        case (obj === null):
            return GLib.Variant.new('mv', null);

        case (typeof obj.map === 'function'):
            return GLib.Variant.new(
                'av',
                obj.filter(e => e !== undefined).map(e => _full_pack(e))
            );

        case (obj instanceof Gio.Icon):
            return obj.serialize();

        case (type === 'object'):
            packed = {};

            for (let [key, val] of Object.entries(obj)) {
                if (val !== undefined)
                    packed[key] = _full_pack(val);
            }

            return GLib.Variant.new('a{sv}', packed);

        default:
            throw Error(`Unsupported type '${type}': ${obj}`);
    }
}

GLib.Variant.full_pack = _full_pack;


/**
 * Extend GLib.Variant with a method to recursively deepUnpack() a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 * @return {*} The resulting object
 */
function _full_unpack(obj) {
    obj = (obj === undefined) ? this : obj;
    let unpacked = {};

    switch (true) {
        case (obj === null):
            return obj;

        case (obj instanceof GLib.Variant):
            return _full_unpack(obj.deepUnpack());

        case (obj instanceof Uint8Array):
            return obj;

        case (typeof obj.map === 'function'):
            return obj.map(e => _full_unpack(e));

        case (typeof obj === 'object'):
            for (let [key, value] of Object.entries(obj)) {
                // Try to detect and deserialize GIcons
                try {
                    if (key === 'icon' && value.get_type_string() === '(sv)')
                        unpacked[key] = Gio.Icon.deserialize(value);
                    else
                        unpacked[key] = _full_unpack(value);
                } catch (e) {
                    unpacked[key] = _full_unpack(value);
                }
            }

            return unpacked;

        default:
            return obj;
    }
}

GLib.Variant.prototype.full_unpack = _full_unpack;


/**
 * Creates a GTlsCertificate from the PEM-encoded data in @cert_path and
 * @key_path. If either are missing a new pair will be generated.
 *
 * Additionally, the private key will be added using ssh-add to allow sftp
 * connections using Gio.
 *
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/core/kdeconnectconfig.cpp#L119
 *
 * @param {string} certPath - Absolute path to a x509 certificate in PEM format
 * @param {string} keyPath - Absolute path to a private key in PEM format
 * @param {string} commonName - A unique common name for the certificate
 * @return {Gio.TlsCertificate} A TLS certificate
 */
Gio.TlsCertificate.new_for_paths = function (certPath, keyPath, commonName = null) {
    // Check if the certificate/key pair already exists
    let certExists = GLib.file_test(certPath, GLib.FileTest.EXISTS);
    let keyExists = GLib.file_test(keyPath, GLib.FileTest.EXISTS);

    // Create a new certificate and private key if necessary
    if (!certExists || !keyExists) {
        // If we weren't passed a common name, generate a random one
        if (!commonName)
            commonName = GLib.uuid_string_random();

        let proc = new Gio.Subprocess({
            argv: [
                Config.OPENSSL_PATH, 'req',
                '-new', '-x509', '-sha256',
                '-out', certPath,
                '-newkey', 'rsa:4096', '-nodes',
                '-keyout', keyPath,
                '-days', '3650',
                '-subj', `/O=andyholmes.github.io/OU=GSConnect/CN=${commonName}`,
            ],
            flags: (Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_SILENCE),
        });
        proc.init(null);
        proc.wait_check(null);
    }

    return Gio.TlsCertificate.new_from_files(certPath, keyPath);
};

Object.defineProperties(Gio.TlsCertificate.prototype, {
    /**
     * Compute a SHA1 fingerprint of the certificate.
     * See: https://gitlab.gnome.org/GNOME/glib/issues/1290
     *
     * @return {string} A SHA1 fingerprint of the certificate.
     */
    'fingerprint': {
        value: function () {
            if (!this.__fingerprint) {
                let proc = new Gio.Subprocess({
                    argv: [Config.OPENSSL_PATH, 'x509', '-noout', '-fingerprint', '-sha1', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
                });
                proc.init(null);

                let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
                this.__fingerprint = /[a-zA-Z0-9:]{59}/.exec(stdout)[0];
            }

            return this.__fingerprint;
        },
        enumerable: false,
    },

    /**
     * The common name of the certificate.
     */
    'common_name': {
        get: function () {
            if (!this.__common_name) {
                let proc = new Gio.Subprocess({
                    argv: [Config.OPENSSL_PATH, 'x509', '-noout', '-subject', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
                });
                proc.init(null);

                let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
                this.__common_name = /(?:cn|CN) ?= ?([^,\n]*)/.exec(stdout)[1];
            }

            return this.__common_name;
        },
        enumerable: true,
    },
});

