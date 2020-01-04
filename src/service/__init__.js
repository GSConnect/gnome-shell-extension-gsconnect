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
window._WAYLAND = GLib.getenv('XDG_SESSION_TYPE') === 'wayland';
window.HAVE_REMOTEINPUT = GLib.getenv('GDMSESSION') !== 'ubuntu-wayland';


/**
 * A custom debug function that logs at LEVEL_MESSAGE to avoid the need for env
 * variables to be set.
 *
 * @param {Error|string} message - A string or Error to log
 * @param {string} [prefix] - An optional prefix for the warning
 */
const _debugFunc = function(message, prefix = null) {
    let caller;

    if (message.stack) {
        caller = message.stack.split('\n')[0];
        message = `${message.message}\n${message.stack}`;
    } else {
        message = JSON.stringify(message, null, 2);
        caller = (new Error()).stack.split('\n')[1];
    }

    // Prepend prefix
    message = (prefix) ? `${prefix}: ${message}` : message;

    // Cleanup the stack
    let [, func, file, line] = caller.match(/([^@]*)@([^:]*):([^:]*)/);
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
window.debug = gsconnect.settings.get_boolean('debug') ? _debugFunc : () => {};

gsconnect.settings.connect('changed::debug', (settings) => {
    window.debug = settings.get_boolean('debug') ? _debugFunc : () => {};
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
 * A convenience function for checking if a KDE Connect packet has a payload.
 *
 * @returns (boolean} - %true if @packet has a payload
 */
Object.prototype.hasPayload = function() {
    if (!this.hasOwnProperty('payloadSize') || this.payloadSize === 0)
        return false;

    if (!this.hasOwnProperty('payloadTransferInfo'))
        return false;

    return (Object.keys(this.payloadTransferInfo).length > 0);
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
 * The same regular expression used in GNOME Shell
 *
 * http://daringfireball.net/2010/07/improved_regex_for_matching_urls
 */
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:http|https|ftp)://' +             // scheme://
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');


/**
 * Return a string with URLs couched in <a> tags, parseable by Pango and
 * using the same RegExp as GNOME Shell.
 *
 * @param {string} text - The string to be modified
 * @return {string} - the modified text
 */
String.prototype.linkify = function(title = null) {
    let text = GLib.markup_escape_text(this, -1);

    _urlRegexp.lastIndex = 0;

    if (title) {
        return text.replace(
            _urlRegexp,
            `$1<a href="$2" title="${title}">$2</a>`
        );
    } else {
        return text.replace(_urlRegexp, '$1<a href="$2">$2</a>');
    }
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

        case (obj instanceof ByteArray.ByteArray):
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
 * Extend GLib.Variant with a method to recursively deep_unpack() a variant
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
            return _full_unpack(obj.deep_unpack());

        case (obj instanceof ByteArray.ByteArray):
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

