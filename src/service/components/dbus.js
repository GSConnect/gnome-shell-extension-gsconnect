'use strict';

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Some utility methods
 */
String.prototype.toDBusCase = function(string) {
    string = string || this;

    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
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


/**
 * A convenience function to recursively unpack a GVariant
 *
 * @param {*} obj - May be a GLib.Variant, Array, standard Object or literal.
 * @return {*} - Returns the contents of @obj with any GVariants unpacked to
 *               their native JavaScript equivalents.
 */
function full_unpack(obj) {
    let unpacked;

    switch (true) {
        case (obj === null):
            return obj;

        case (obj instanceof GLib.Variant):
            return full_unpack(obj.deep_unpack());

        case (obj instanceof imports.byteArray.ByteArray):
            return obj;

        case (typeof obj.map === 'function'):
            return obj.map(e => full_unpack(e));

        case (typeof obj === 'object'):
            unpacked = {};

            for (let [key, value] of Object.entries(obj)) {
                // Try to detect and deserialize GIcons
                try {
                    if (key === 'icon' && value.get_type_string() === '(sv)') {
                        unpacked[key] = Gio.Icon.deserialize(value);
                    } else {
                        unpacked[key] = full_unpack(value);
                    }
                } catch (e) {
                    unpacked[key] = full_unpack(value);
                }
            }

            return unpacked;

        default:
            return obj;
    }
}


function _makeOutSignature(args) {
    var ret = '(';
    for (var i = 0; i < args.length; i++)
        ret += args[i].signature;

    return ret + ')';
}



/**
 * Convert a string of GVariantType to a list of GType
 *
 * @param {string} types - A string of GVariantType characters (eg. a{sv})
 * @return {Array} - A list of GType constants
 */
function vtype_to_gtype(types) {
    if (vtype_to_gtype._cache === undefined) {
        vtype_to_gtype._cache = {};
    }

    if (!vtype_to_gtype._cache.hasOwnProperty(types)) {
        let gtypes = [];

        for (let i = 0; i < types.length; i++) {
            switch (types[i]) {
                case 'b':
                    gtypes.push(GObject.TYPE_BOOLEAN);
                    break;

                case 's':
                case 'o':
                case 'g':
                    gtypes.push(GObject.TYPE_STRING);
                    break;

                case 'h' || 'i':
                    gtypes.push(GObject.TYPE_INT);
                    break;

                case 'u':
                    gtypes.push(GObject.TYPE_UINT);
                    break;

                case 'x':
                    gtypes.push(GObject.TYPE_INT64);
                    break;

                case 't':
                    gtypes.push(GObject.TYPE_UINT64);
                    break;

                case 'd':
                    gtypes.push(GObject.TYPE_DOUBLE);
                    break;

                case 'y':
                    gtypes.push(GObject.TYPE_UCHAR);
                    break;

                // FIXME: assume it's a variant
                default:
                    gtypes.push(GObject.TYPE_VARIANT);
            }
        }

        vtype_to_gtype._cache[types] = gtypes;
    }

    return vtype_to_gtype._cache[types];
}


/**
 * DBus.Interface represents a DBus interface bound to an object instance, meant
 * to be exported over DBus.
 */
var Interface = GObject.registerClass({
    GTypeName: 'GSConnectDBusInterface'
}, class Interface extends GjsPrivate.DBusImplementation {

    _init(params) {
        super._init({
            g_interface_info: params.g_interface_info
        });

        this._exportee = params.g_instance;

        if (params.g_object_path) {
            this.g_object_path = params.g_object_path;
        }

        // Bind Object
        let info = this.get_info();
        this._exportMethods(info);
        this._exportProperties(info);
        this._exportSignals(info);

        // Export if connection and object path were given
        if (params.g_connection && params.g_object_path) {
            this.export(params.g_connection, params.g_object_path);
        }
    }

    // HACK: for some reason the getter doesn't work properly on the parent
    get g_interface_info() {
        return this.get_info();
    }

    /**
     * Invoke an instance's method for a DBus method call. Supports promises.
     */
    async _call(info, memberName, parameters, invocation) {
        // Convert member casing to native casing
        let nativeName;

        if (this[memberName]) {
            nativeName = memberName;
        } else if (this[memberName.toUnderscoreCase()]) {
            nativeName = memberName.toUnderscoreCase();
        } else if (this[memberName.toCamelCase()]) {
            nativeName = memberName.toCamelCase();
        }

        let retval;

        try {
            parameters = parameters.unpack().map(parameter => {
                if (parameter.get_type_string() === 'h') {
                    let message = invocation.get_message();
                    let fds = message.get_unix_fd_list();
                    let idx = parameter.deep_unpack();
                    return fds.get(idx);
                } else {
                    return full_unpack(parameter);
                }
            });

            // await all method invocations to support Promise returns
            retval = await this[nativeName].apply(this, parameters);
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                let name = e.name;

                if (name.includes('.')) {
                    // likely to be a normal JS error
                    name = `org.gnome.gjs.JSError.${name}`;
                }

                invocation.return_dbus_error(name, e.message);
                logError(e, `${this}: ${memberName}`);
            }

            return;
        }

        // undefined (no return value) is the empty tuple
        if (retval === undefined) {
            retval = new GLib.Variant('()', []);
        }

        // Try manually packing a variant
        try {
            if (!(retval instanceof GLib.Variant)) {
                let outArgs = info.lookup_method(memberName).out_args;
                retval = new GLib.Variant(
                    _makeOutSignature(outArgs),
                    (outArgs.length == 1) ? [retval] : retval
                );
            }

            invocation.return_value(retval);

        // Without a response, the client will wait for timeout
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.gjs.JSError.ValueError',
                'Service implementation returned an incorrect value type'
            );

            logError(e);
        }
    }

    _exportMethods(info) {
        if (info.methods.length === 0) {
            return;
        }

        this.connect('handle-method-call', (impl, name, parameters, invocation) => {
            return this._call.call(
                this._exportee,
                this.g_interface_info,
                name,
                parameters,
                invocation
            );
        });
    }

    _get(info, propertyName) {
        // Look up the property info
        let propertyInfo = info.lookup_property(propertyName);
        // Convert to lower_underscore case before getting
        let value = this[propertyName.toUnderscoreCase()];

        // TODO: better pack
        if (value != undefined) {
            return new GLib.Variant(propertyInfo.signature, value);
        }

        return null;
    }

    _set(info, name, value) {
        value = full_unpack(value);

        if (!this._propertyCase) {
            if (this[name.toUnderscoreCase()]) {
                this._propertyCase = 'toUnderScoreCase';
            } else if (this[name.toCamelCase()]) {
                this._propertyCase = 'toCamelCase';
            }
        }

        // Convert to lower_underscore case before setting
        this[name[this._propertyCase]()] = value;
    }

    _exportProperties(info) {
        if (info.properties.length === 0) {
            return;
        }

        this.connect('handle-property-get', (impl, name) => {
            return this._get.call(this._exportee, info, name);
        });

        this.connect('handle-property-set', (impl, name, value) => {
            return this._set.call(this._exportee, info, name, value);
        });

        this._exportee.connect('notify', (obj, paramSpec) => {
            let name = paramSpec.name.toDBusCase();
            let propertyInfo = this.g_interface_info.lookup_property(name);

            if (propertyInfo) {
                this.emit_property_changed(
                    name,
                    new GLib.Variant(
                        propertyInfo.signature,
                        // Adjust for GJS's '-'/'_' conversion
                        this._exportee[paramSpec.name.replace(/-/gi, '_')]
                    )
                );
            }
        });
    }

    _exportSignals(info) {
        for (let signal of info.signals) {
            this._exportee.connect(signal.name.toHyphenCase(), (obj, ...args) => {
                this.emit_signal(
                    signal.name,
                    new GLib.Variant(
                        `(${signal.args.map(arg => arg.signature).join('')})`,
                        args
                    )
                );
            });
        }
    }

    destroy() {
        this.flush();
        this.unexport();
        GObject.signal_handlers_destroy(this);
    }
});


/**
 * Wrapper for org.freedesktop.DBus.Properties.Get
 *
 * @param {string} name - The property name
 * @return {*} - A native property value
 */
function _proxyGetter(name) {
    let variant;

    try {
        if (this.no_cache) {
            // Call returns '(v)' so unpack the tuple and return that variant
            variant = this.call_sync(
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [this.g_interface_name, name]),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            ).deep_unpack()[0];
        }
    } catch (e) {
        logError(e);
    }

    // Fallback to cached property...
    variant = variant ? variant : this.get_cached_property(name);
    return variant ? full_unpack(variant) : null;
}


/**
 * Wrapper for org.freedesktop.DBus.Properties.Set
 *
 * @param {string} name - The property name
 * @param {string} signature - The property signature
 * @param {string} value - A native property value
 */
function _proxySetter(name, signature, value) {
    // Pack the new value
    let variant = new GLib.Variant(signature, value);

    // Set the cached property first
    this.set_cached_property(name, variant);

    // Let it run asynchronously and just log any errors
    this.call(
        'org.freedesktop.DBus.Properties.Set',
        new GLib.Variant('(ssv)', [this.g_interface_name, name, variant]),
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (proxy, result) => {
            try {
                this.call_finish(result);
            } catch (e) {
                logError(e);
            }
        }
    );
}


function proxyProperties(iface, info) {
    let i, properties = info.properties;

    for (i = 0; i < properties.length; i++) {
        let property = properties[i];

        Object.defineProperty(iface, property.name, {
            get: _proxyGetter.bind(iface, property.name),
            set: _proxySetter.bind(iface, property.name, property.signature),
            enumerable: true
        });
    }
}


/**
 * Create proxy wrappers for the methods on an interface
 */
function _proxyInvoker(method, ...argv) {
    return new Promise((resolve, reject) => {
        let signature = method.in_args.map(arg => arg.signature).join('');
        let variant = new GLib.Variant(`(${signature})`, argv);

        this.call(method.name, variant, 0, -1, null, (proxy, res) => {
            try {
                res = proxy.call_finish(res);

                // If return has single arg, only return that or null
                if (method.out_args.length === 1) {
                    resolve((res) ? res.deep_unpack()[0] : null);

                // Otherwise return an array (possibly empty)
                } else {
                    resolve((res) ? res.deep_unpack() : []);
                }
            } catch (e) {
                e.stack = `${method.name}@${this.g_object_path}\n${e.stack}`;
                reject(e);
            }
        });
    });
}


function proxyMethods(iface, info) {
    let i, methods = info.methods;

    for (i = 0; i < methods.length; i++) {
        let method = methods[i];
        iface[method.name] = _proxyInvoker.bind(iface, method);
    }
}


/**
 * A convenience Promise wrapper for Gio.AsyncInitable.init_async(). Unlike the
 * generic function, this will return the proxy on success instead of a boolean.
 *
 * @param {Gio.Cancellable} cancellable - A cancellable or %null
 * @return {Gio.DBusProxy} - The initted proxy object
 */
Gio.DBusProxy.prototype.init_promise = function(cancellable = null) {
    return new Promise((resolve, reject) => {
        this.init_async(GLib.PRIORITY_DEFAULT, cancellable, (proxy, res) => {
            try {
                proxy.init_finish(res);
                resolve(proxy);
            } catch (e) {
                reject(e);
            }
        });
    });
};


/**
 * Return a "heavy" Gio.DBusProxy subclass prepped with methods, properties and
 * signals described by @info. Methods will be wrapped as async functions,
 * properties as GProperties with notify/bind support and signals as GSignals.
 *
 * @param {Gio.DBusInterfaceInfo} info - The supported interface
 * @return {Gio.DBusProxyClass} - The constructor object for the subclass
 */
function makeInterfaceProxy(info) {
    // Cache built proxies (also avoids GType collisions)
    if (makeInterfaceProxy._cache === undefined) {
        makeInterfaceProxy._cache = {};
    }

    // Check if we've already prepared a proxy for this interface
    if (makeInterfaceProxy._cache.hasOwnProperty(info.name)) {
        return makeInterfaceProxy._cache[info.name];
    }

    // GProperty ParamSpec's
    let properties_ = {
        'no-cache': GObject.ParamSpec.boolean(
            'no-cache',
            'No Cache',
            'Fetch properties synchronously',
            GObject.ParamFlags.READWRITE,
            null
        )
    };

    for (let i = 0, len = info.properties.length; i < len; i++) {
        let property = info.properties[i];
        let flags = 0;

        if (property.flags & Gio.DBusPropertyInfoFlags.READABLE) {
            flags |= GObject.ParamFlags.READABLE;
        }

        if (property.flags & Gio.DBusPropertyInfoFlags.WRITABLE) {
            flags |= GObject.ParamFlags.WRITABLE;
        }

        switch (true) {
            case (property.signature === 'b'):
                properties_[property.name] = GObject.ParamSpec.boolean(
                    property.name,
                    property.name,
                    `${property.name}: automatically populated`,
                    flags,
                    false
                );
                break;

            case 'sog'.includes(property.signature):
                properties_[property.name] = GObject.ParamSpec.string(
                    property.name,
                    property.name,
                    `${property.name}: automatically populated`,
                    flags,
                    ''
                );
                break;

            // TODO: all number types are converted to Number (double) anyways,
            //       but there may be a case where type is relevant on the proxy
            case 'hiuxtd'.includes(property.signature):
                properties_[property.name] = GObject.ParamSpec.double(
                    property.name,
                    property.name,
                    `${property.name}: automatically populated`,
                    flags,
                    GLib.MININT32, GLib.MAXINT32,
                    0.0
                );
                break;

            // Fallback to GVariant if it's not a native type
            default:
                properties_[property.name] = GObject.param_spec_variant(
                    property.name,
                    property.name,
                    `${property.name}: automatically populated`,
                    new GLib.VariantType(property.signature),
                    null,
                    flags
                );
        }
    }

    // GSignal Spec's
    let signals_ = {};

    for (let i = 0, len = info.signals.length; i < len; i++) {
        let signal = info.signals[i];

        signals_[signal.name] = {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: vtype_to_gtype(signal.args.map(arg => arg.signature).join(''))
        };
    }

    // Register and store the proxy class
    makeInterfaceProxy._cache[info.name] = GObject.registerClass({
        GTypeName: 'PROXY_' + info.name.split('.').join(''),
        Implements: [Gio.DBusInterface],
        Properties: properties_,
        Signals: signals_
    }, class InterfaceProxy extends Gio.DBusProxy {

        _init(params) {
            super._init(Object.assign({
                g_interface_info: info,
                g_interface_name: info.name,
                no_cache: false
            }, params));

            // Proxy methods and properties
            proxyMethods(this, this.g_interface_info);
            proxyProperties(this, this.g_interface_info);
        }

        vfunc_g_properties_changed(changed, invalidated) {
            for (let name in changed.deep_unpack()) {
                try {
                    this.notify(name);
                } catch (e) {
                    logError(e, name);
                }
            }
        }

        vfunc_g_signal(sender_name, signal_name, parameters) {
            try {
                parameters = parameters.deep_unpack();
                this.emit(signal_name, ...parameters);
            } catch (e) {
                logError(e, signal_name);
            }
        }

        destroy() {
            GObject.signal_handlers_destroy(this);
        }
    });

    return makeInterfaceProxy._cache[info.name];
}

