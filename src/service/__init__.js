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
     * Return the index of an item in the menu by attribute and value
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
     * Return the index of the first GMenuItem found with @action
     * @param {String} name - The action name (without scope)
     * @return {Number} - The index of the action
     */
    'get_action': {
        value: function(name) {
            return this._get('action', `device.${name}`);
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
            item.set_label(action.summary);
            item.set_icon(new Gio.ThemedIcon({ name: action.icon_name }));
            item.set_attribute_value(
                'hidden-when',
                new GLib.Variant('s', 'action-disabled')
            );

            // TODO: targetted actions
            item.set_detailed_action(`device.${action.name}`);

            // FIXME: need GSettings for this, and editor :'(
            if (index === -1) {
                this.append_item(item);
            } else {
                this.insert_item(index, item);
            }

            return this.get_n_items();
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

            if (index > -1) {
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
    },

    /**
     * Remove a GMenuItem by label
     *
     * @param {String} name - Label of the item to remove
     * @return {Number} - The index of the removed item or -1 if not found
     */
    'remove_labeled': {
        value: function(name) {
            return this._remove('label', name);
        },
        enumerable: false
    },

    /**
     * Replace a GMenuItem by label with another. If @name is not found @item
     * will be appended to the end of the menu.
     *
     * @param {String} name - Label of the item to replace
     * @param {Gio.MenuItem} item - Menu item to replace the removed item
     */
    'replace_labeled': {
        value: function(name, item) {
            let index = this.remove_labeled(name);

            if (index > -1) {
                this.insert_item(index, item);
            } else {
                this.append_item(item);
            }
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

