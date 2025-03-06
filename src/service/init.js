// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {watchService} from '../wl_clipboard.js';

import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';

import Config from '../config.js';
import setup, {setupGettext} from '../utils/setup.js';


// Promise Wrappers
// We don't use top-level await since it returns control flow to importing module, causing bugs
import('gi://EBook').then(({default: EBook}) => {
    Gio._promisify(EBook.BookClient, 'connect');
    Gio._promisify(EBook.BookClient.prototype, 'get_view');
    Gio._promisify(EBook.BookClient.prototype, 'get_contacts');
}).catch(console.debug);
import('gi://EDataServer').then(({default: EDataServer}) => {
    Gio._promisify(EDataServer.SourceRegistry, 'new');
}).catch(console.debug);

Gio._promisify(Gio.AsyncInitable.prototype, 'init_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusProxy.prototype, 'call');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async',
    'read_line_finish_utf8');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'mount_enclosing_volume');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async',
    'replace_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Mount.prototype, 'unmount_with_operation');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.SocketListener.prototype, 'accept_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');
Gio._promisify(Gio.TlsConnection.prototype, 'handshake_async');
Gio._promisify(Gio.DtlsConnection.prototype, 'handshake_async');


// User Directories
Config.CACHEDIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gsconnect']);
Config.CONFIGDIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'gsconnect']);
Config.RUNTIMEDIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gsconnect']);

// Bootstrap
const serviceFolder = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const extensionFolder = GLib.path_get_dirname(serviceFolder);
setup(extensionFolder);
setupGettext();

if (Config.IS_USER) {
    // Infer libdir by assuming gnome-shell shares a common prefix with gjs;
    // assume the parent directory if it's not there
    let libdir = GIRepository.Repository.get_search_path().find(path => {
        return path.endsWith('/gjs/girepository-1.0');
    }).replace('/gjs/girepository-1.0', '');

    const gsdir = GLib.build_filenamev([libdir, 'gnome-shell']);

    if (!GLib.file_test(gsdir, GLib.FileTest.IS_DIR)) {
        const currentDir = `/${GLib.path_get_basename(libdir)}`;
        libdir = libdir.replace(currentDir, '');
    }

    Config.GNOME_SHELL_LIBDIR = libdir;
}


// Load DBus interfaces
Config.DBUS = (() => {
    const bytes = Gio.resources_lookup_data(
        GLib.build_filenamev([Config.APP_PATH, `${Config.APP_ID}.xml`]),
        Gio.ResourceLookupFlags.NONE
    );

    const xml = new TextDecoder().decode(bytes.toArray());
    const dbus = Gio.DBusNodeInfo.new_for_xml(xml);
    dbus.nodes.forEach(info => info.cache_build());

    return dbus;
})();


// Init User Directories
for (const path of [Config.CACHEDIR, Config.CONFIGDIR, Config.RUNTIMEDIR])
    GLib.mkdir_with_parents(path, 0o755);


globalThis.HAVE_GNOME = GLib.getenv('GSCONNECT_MODE')?.toLowerCase() !== 'cli' && (GLib.getenv('GNOME_SETUP_DISPLAY') !== null || GLib.getenv('XDG_CURRENT_DESKTOP')?.toUpperCase()?.includes('GNOME') || GLib.getenv('XDG_SESSION_DESKTOP')?.toLowerCase() === 'gnome');


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

    const [, func, file, line] = _debugCallerMatch.exec(caller);
    const script = file.replace(Config.PACKAGE_DATADIR, '');

    GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
        'MESSAGE': `[${script}:${func}:${line}]: ${message}`,
        'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect',
        'CODE_FILE': file,
        'CODE_FUNC': func,
        'CODE_LINE': line,
    });
};

globalThis._debugFunc = _debugFunc;

const settings = new Gio.Settings({
    settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
});
if (settings.get_boolean('debug')) {
    globalThis.debug = globalThis._debugFunc;
} else {
    // Swap the function out for a no-op anonymous function for speed
    globalThis.debug = () => {};
}

/**
 * Start wl_clipboard if not under Gnome
 */
if (!globalThis.HAVE_GNOME) {
    debug('Not running as a Gnome extension');
    watchService();
}


/**
 * A simple (for now) pre-comparison sanitizer for phone numbers
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/smsapp/conversationlistmodel.cpp#L200-L210
 *
 * @returns {string} Return the string stripped of leading 0, and ' ()-+'
 */
String.prototype.toPhoneNumber = function () {
    const strippedNumber = this.replace(/^0*|[ ()+-]/g, '');

    if (strippedNumber.length)
        return strippedNumber;

    return this;
};


/**
 * A simple equality check for phone numbers based on `toPhoneNumber()`
 *
 * @param {string} number - A phone number string to compare
 * @returns {boolean} If `this` and @number are equivalent phone numbers
 */
String.prototype.equalsPhoneNumber = function (number) {
    const a = this.toPhoneNumber();
    const b = number.toPhoneNumber();

    return (a.length && b.length && (a.endsWith(b) || b.endsWith(a)));
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
            const iter = file.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let info;

            while ((info = iter.next_file(null)))
                Gio.File.rm_rf(iter.get_child(info));

            iter.close(null);
        } catch {
            // Silence errors
        }

        file.delete(null);
    } catch {
        // Silence errors
    }
};


/**
 * Extend GLib.Variant with a static method to recursively pack a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 * @returns {GLib.Variant} The resulting GVariant
 */
function _full_pack(obj) {
    let packed;
    const type = typeof obj;

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

            for (const [key, val] of Object.entries(obj)) {
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
 * @returns {*} The resulting object
 */
function _full_unpack(obj) {
    obj = (obj === undefined) ? this : obj;
    const unpacked = {};

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
            for (const [key, value] of Object.entries(obj)) {
                // Try to detect and deserialize GIcons
                try {
                    if (key === 'icon' && value.get_type_string() === '(sv)')
                        unpacked[key] = Gio.Icon.deserialize(value);
                    else
                        unpacked[key] = _full_unpack(value);
                } catch {
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
 * Creates a GTlsCertificate from the PEM-encoded data in %cert_path and
 * %key_path. If either are missing a new pair will be generated.
 *
 * Additionally, the private key will be added using ssh-add to allow sftp
 * connections using Gio.
 *
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/core/kdeconnectconfig.cpp#L119
 *
 * @param {string} certPath - Absolute path to a x509 certificate in PEM format
 * @param {string} keyPath - Absolute path to a private key in PEM format
 * @param {string} commonName - A unique common name for the certificate
 * @returns {Gio.TlsCertificate} A TLS certificate
 */
Gio.TlsCertificate.new_for_paths = function (certPath, keyPath, commonName = null) {
    // Check if the certificate/key pair already exists
    const certExists = GLib.file_test(certPath, GLib.FileTest.EXISTS);
    const keyExists = GLib.file_test(keyPath, GLib.FileTest.EXISTS);

    // Create a new certificate and private key if necessary
    if (!certExists || !keyExists) {
        // If we weren't passed a common name, generate a random one
        if (!commonName)
            commonName = GLib.uuid_string_random().replaceAll('-', '_');

        const proc = new Gio.Subprocess({
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
     * The common name of the certificate.
     */
    'common_name': {
        get: function () {
            if (!this.__common_name) {
                const proc = new Gio.Subprocess({
                    argv: [Config.OPENSSL_PATH, 'x509', '-noout', '-subject', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
                });
                proc.init(null);

                const stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
                this.__common_name = /(?:cn|CN) ?= ?([^,\n]*)/.exec(stdout)[1];
            }

            return this.__common_name;
        },
        configurable: true,
        enumerable: true,
    },

    /**
     * Get just the pubkey as a DER ByteArray of a certificate.
     *
     * @returns {GLib.Bytes} The pubkey as DER of the certificate.
     */
    'pubkey_der': {
        value: function () {
            if (!this.__pubkey_der) {
                let proc = new Gio.Subprocess({
                    argv: [Config.OPENSSL_PATH, 'x509', '-noout', '-pubkey', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
                });
                proc.init(null);

                const pubkey = proc.communicate_utf8(this.certificate_pem, null)[1];
                proc = new Gio.Subprocess({
                    argv: [Config.OPENSSL_PATH, 'pkey', '-pubin', '-inform', 'pem', '-outform', 'der'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
                });
                proc.init(null);
                this.__pubkey_der = proc.communicate(new TextEncoder().encode(pubkey), null)[1];
            }

            return this.__pubkey_der;
        },
        configurable: true,
        enumerable: false,
    },

});
