'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

/**
 * Overrides and polyfills are kept here so we don't mangle or collide with the
 * prototypes of other processes (eg. gnome-shell).
 */
debug('loading service/__init__.js');


/**
 * Extend Gio.Menu with some convenience methods for Device menus and working
 * with menu items.
 */
Object.defineProperties(Gio.Menu.prototype, {
    /**
     * Return the position of an item in the menu by attribute and value
     *
     * @param {String} name - The attribute name (eg. 'label', 'action')
     * @param {*} - The value of the attribute
     * @return {Number} - The index of the item or %-1 if not found
     */
    '_get': {
        value: function(name, value) {
            let len = this.get_n_items();

            for (let i = 0; i < len; i++) {
                try {
                    let item = this.get_item_attribute_value(i, name, null).unpack();

                    if (item === value) {
                        return i;
                    }
                } catch (e) {
                    continue;
                }
            }

            return -1;
        },
        enumerable: false
    },


    /**
     * Remove an item from the menu by attribute and value
     *
     * @param {String} name - The attribute name (eg. 'label', 'action')
     * @param {*} - The value of the attribute
     * @return {Number} - The index of the removed item or %-1 if not found
     */
    '_remove': {
        value: function(name, value) {
            let index = this._get(name, value);

            if (index > -1) {
                this.remove(index);
            }

            return index;
        },
        enumerable: false
    },

    /**
     * Add a GMenuItem for a plugin action
     *
     * @param {Device.Action} action - The device action to add
     * @return {Number} - The index of the added item
     */
    'add_action': {
        value: function(action, index=-1) {
            let item = new Gio.MenuItem();
            item.set_label(action.label);
            item.set_icon(action.icon);
            item.set_attribute_value(
                'hidden-when',
                new GLib.Variant('s', 'action-disabled')
            );

            // TODO: targetted actions
            item.set_detailed_action(`device.${action.name}`);

            // TODO: menu editor?
            if (index === -1) {
                this.append_item(item);
                return this.get_n_items();
            } else {
                this.insert_item(index, item);
                return index;
            }
        },
        enumerable: false
    },

    /**
     * Remove a GMenuItem by action name, falling back to device.@name if
     * necessary.
     *
     * @param {String} name - Action name of the item to remove
     * @return {Number} - The index of the removed item or -1 if not found
     */
    'remove_action': {
        value: function(name) {
            let index = this._remove('action', name);

            if (index === -1) {
                index = this._remove('action', `device.${name}`);
            }

            return index;
        },
        enumerable: false
    },

    /**
     * Replace the item with the action name @name with @item
     *
     * @param {String} name - Action name of the item to remove
     * @param {Gio.MenuItem} item - The replacement menu item
     * @return {Number} - The index of the replaced item or -1 if not found
     */
    'replace_action': {
        value: function(name, item) {
            let index = this.remove_action(name);

            if (index > -1) {
                this.insert_item(index, item);
            }

            return index;
        },
        enumerable: false
    }
});


/**
 * Extend Gio.TlsCertificate with some convenience methods
 */
Object.defineProperties(Gio.TlsCertificate.prototype, {
    /**
     * Compute a SHA1 fingerprint of the certificate.
     * See: https://gitlab.gnome.org/GNOME/glib/issues/1290
     *
     * @return {string} - A SHA1 fingerprint of the certificate.
     */
    'fingerprint': {
        value: function() {
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
        },
        enumerable: false
    },

    /**
     * The common name of the certificate.
     */
    'common_name': {
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
    }
});


/**
 * Extend GLib.Variant with a static method to recursively pack a variant
 *
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 */
function _full_pack(obj) {
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

        case (obj instanceof imports.byteArray.ByteArray):
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
            let packed = {};

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
 * @param {*} [obj] - May be a GLib.Variant, Array, standard Object or literal.
 */
function _full_unpack(obj) {
    obj = (obj === undefined) ? this : obj;

    switch (true) {
        case (obj === null):
            return obj;

        case (obj instanceof GLib.Variant):
            return _full_unpack(obj.deep_unpack());

        case (obj instanceof imports.byteArray.ByteArray):
            return obj;

        case (typeof obj.map === 'function'):
            return obj.map(e => _full_unpack(e));

        case (typeof obj === 'object'):
            let unpacked = {};

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

