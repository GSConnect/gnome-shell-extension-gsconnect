'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const ByteArray = imports.byteArray;


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
const _debugFunc = function(message, prefix = null) {
    let caller;

    if (message.stack) {
        caller = message.stack.split('\n')[0];
        message = `${message.message}\n${message.stack}`;
    } else {
        caller = (new Error()).stack.split('\n')[1];
        message = JSON.stringify(message, null, 2);
    }

    // Prepend prefix
    if (prefix)
        message = `${prefix}: ${message}`;

    // Cleanup the stack
    let [, func, file, line] = _debugCallerMatch.exec(caller);
    let script = file.replace(gsconnect.extdatadir, '');

    GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
        'MESSAGE': `[${script}:${func}:${line}]: ${message}`,
        'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect',
        'CODE_FILE': file,
        'CODE_FUNC': func,
        'CODE_LINE': line
    });
};

// Swap the function out for a no-op anonymous function for speed
if (gsconnect.settings.get_boolean('debug')) {
    globalThis.debug = _debugFunc;
} else {
    globalThis.debug = () => {};
}

gsconnect.settings.connect('changed::debug', (settings, key) => {
    globalThis.debug = settings.get_boolean(key) ? _debugFunc : () => {};
});


/**
 * Convenience function for loading JSON from a file
 *
 * @param {Gio.File|string} file - A Gio.File or path to a JSON file
 * @param {boolean} sync - Default is %false, if %true load synchronously
 * @return {object} - The parsed object
 */
JSON.load = function (file, sync = false) {
    if (typeof file === 'string') {
        file = Gio.File.new_for_path(file);
    }

    if (sync) {
        let contents = file.load_contents(null)[1];

        return JSON.parse(ByteArray.toString(contents));
    } else {
        return new Promise((resolve, reject) => {
            file.load_contents_async(null, (file, res) => {
                try {
                    let contents = file.load_contents_finish(res)[1];

                    resolve(JSON.parse(ByteArray.toString(contents)));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
};


/**
 * Convenience function for dumping JSON to a file
 *
 * @param {Gio.File|string} file - A Gio.File or file path
 * @param {object} obj - The object to write to disk
 * @param {boolean} sync - Default is %false, if %true load synchronously
 */
JSON.dump = function (obj, file, sync = false) {
    if (typeof file === 'string') {
        file = Gio.File.new_for_path(file);
    }

    if (sync) {
        file.replace_contents(
            JSON.stringify(obj, null, 2),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } else {
        return new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(
                new GLib.Bytes(JSON.stringify(obj, null, 2)),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (file, res) => {
                    try {
                        file.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
};


/**
 * Idle Promise
 *
 * @param {number} priority - The priority of the idle source
 */
Promise.idle = function(priority) {
    return new Promise(resolve => GLib.idle_add(priority, resolve));
};


/**
 * Timeout Promise
 *
 * @param {number} priority - The priority of the timeout source
 * @param {number} interval - Delay in milliseconds before resolving
 */
Promise.timeout = function(priority = GLib.PRIORITY_DEFAULT, interval = 100) {
    return new Promise(resolve => GLib.timeout_add(priority, interval, resolve));
};


/**
 * A simple (for now) pre-comparison sanitizer for phone numbers
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/smsapp/conversationlistmodel.cpp#L200-L210
 *
 * @return {string} - Return the string stripped of leading 0, and ' ()-+'
 */
String.prototype.toPhoneNumber = function() {
    let strippedNumber = this.replace(/^0*|[ ()+-]/g, '');

    if (strippedNumber.length)
        return strippedNumber;

    return this;
};

/**
 * A simple equality check for phone numbers based on `toPhoneNumber()`
 *
 * @param {string} number - A phone number string to compare
 * @return {boolean} - If `this` and @number are equivalent phone numbers
 */
String.prototype.equalsPhoneNumber = function(number) {
    let a = this.toPhoneNumber();
    let b = number.toPhoneNumber();

    return (a.endsWith(b) || b.endsWith(a));
};


/**
 * An implementation of `rm -rf` in Gio
 */
Gio.File.rm_rf = function(file) {
    try {
        if (typeof file === 'string') {
            file = Gio.File.new_for_path(file);
        }

        try {
            let iter = file.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let info;

            while ((info = iter.next_file(null))) {
                Gio.File.rm_rf(iter.get_child(info));
            }

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
                if (val !== undefined) {
                    packed[key] = _full_pack(val);
                }
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
 * TODO: this is duplicated in components/dbus.js and it probably shouldn't be,
 *       but dbus.js can stand on it's own if it is...
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 */
function _full_unpack(obj) {
    obj = (obj === undefined) ? this : obj;
    let unpacked;

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
            unpacked = {};

            for (let [key, value] of Object.entries(obj)) {
                // Try to detect and deserialize GIcons
                try {
                    if (key === 'icon' && value.get_type_string() === '(sv)') {
                        unpacked[key] = Gio.Icon.deserialize(value);
                    } else {
                        unpacked[key] = _full_unpack(value);
                    }
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

