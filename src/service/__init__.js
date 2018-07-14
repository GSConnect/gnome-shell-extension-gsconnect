'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

/**
 * Overrides and Gnome API "polyfills" are kept here so we don't mangle or
 * or collide with the prototypes for other processes (eg. gnome-shell).
 */
debug('loading service/__init__.js');

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

        proc.wait_check(null);
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

            proc.wait_check(null);
        }

        return this.__common_name;
    },
    enumerable: true
});


/**
 * Extend GLib.Variant with a static method to recursively pack a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 */
let _full_pack = function(obj) {
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

        case (obj === null):
            return GLib.Variant.new('mv', null);

        case (typeof obj.map === 'function'):
            return GLib.Variant.new('av', obj.map(e => _full_pack(e)));

        // TODO: test
        case (obj instanceof Gio.Icon):
            return obj.serialize();

        // TODO: test
        case (type === 'object' && typeof obj !== null):
            let packed = {};

            for (let key in obj) {
                packed[key] = _full_pack(obj[key]);
            }

            return GLib.Variant.new('a{sv}', packed);

        default:
            throw Error('Unsupported type');
    }
}

GLib.Variant.full_pack = _full_pack;


/**
 * Extend GLib.Variant with a method to recursively deep_unpack() a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 */
let _full_unpack = function(obj) {
    obj = (obj === undefined) ? this : obj;

    switch (true) {
        case (obj === null):
            return obj;

        case (typeof obj.deep_unpack === 'function'):
            return _full_unpack(obj.deep_unpack());

        case (typeof obj.map === 'function'):
            return obj.map(e => _full_unpack(e));

        case (typeof obj === 'object' && typeof obj !== null):
            let unpacked = {};

            for (let key in obj) {
                unpacked[key] = _full_unpack(obj[key]);
            }

            return unpacked;
        default:
            return obj;
    }
}

GLib.Variant.prototype.full_unpack = _full_unpack;


/**
 * A convenience function for connecting Gtk template callbacks
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
 * A convenience function for disconnecting Gtk template callbacks
 */
Gtk.Widget.prototype.disconnect_template = function() {
    Gtk.Widget.set_connect_func.call(this, function(){});
    this.$templateHandlers.map(([obj, id]) => obj.disconnect(id));
};

