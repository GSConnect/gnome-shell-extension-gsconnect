"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


var ProxyBase = new Lang.Class({
    Name: "GSConnectDBusProxyBase",
    Extends: Gio.DBusProxy,

    _init: function (params) {
        this.parent(Object.assign({
            g_connection: Gio.DBus.session,
            g_name: "org.gnome.Shell.Extensions.GSConnect",
        }, params));

        this.cancellable = new Gio.Cancellable();
        this.init(null);
    },

    _call: function (name) {
        /* Convert arg_array to a *real* array */
        let args = Array.prototype.slice.call(arguments, 1);

        return new Promise((resolve, reject) => {
            let methodInfo = this.gInterfaceInfo.lookup_method(name);
            let signature = methodInfo.in_args.map(arg => arg.signature);
            let variant = new GLib.Variant("(" + signature.join("") + ")", args);

            this.call(name, variant, 0, -1, null, (proxy, result) => {
                let ret;

                try {
                    ret = this.call_finish(result);
                } catch (e) {
                    debug("Error calling " + name + ": " + e.message);
                    reject(e);
                }

                // If return has single arg, only return that or null
                if (methodInfo.out_args.length === 1) {
                    resolve((ret) ? ret.deep_unpack()[0] : null);
                // Otherwise return an array (possibly empty)
                } else {
                    resolve((ret) ? ret.deep_unpack() : []);
                }
            });
        });
    },

    /**
     * Asynchronous Getter
     */
    _get: function (name, signature) {
        let value = this.get_cached_property(name);

        if (!value) {
            signature = signature || this.g_interface_info.lookup_property(name).signature;

            // TODO: test
            if (signature.startsWith("[") || signature.startsWith("as")) {
                return [];
            } else if (signature.startsWith("{") || signature.startsWith("a{")) {
                return {};
            } else if (signature.startsWith("u") || signature.startsWith("i")) {
                return 0;
            } else if (signature.startsWith("s")) {
                return "";
            } else if (signature.startsWith("b")) {
                return false;
            }
        } else {
            return value ? value.deep_unpack() : null;
        }
    },

    /**
     * Asynchronous Setter
     */
    _set: function (name, value, signature) {
        if (!signature) {
            let propertyInfo = this.gInterfaceInfo.lookup_property(name);
            let variant = new GLib.Variant(propertyInfo.signature, value);
        }

        // Set the cached property first
        this.set_cached_property(name, variant);

        this.call(
            "org.freedesktop.DBus.Properties.Set",
            new GLib.Variant("(ssv)", [this.g_interface_name, name, variant]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable,
            (proxy, result) => {
                try {
                    this.call_finish(result);
                } catch (e) {
                    debug(
                        "Error setting " + name + " on " + this.g_object_path +
                        ": " + e.message + "\n" + e.stack
                    );
                }
            }
        );
    },

    _wrapMethod: function (name) {
        return function () {
            return this._call.call(this, name, ...arguments);
        };
    },

    /**
     * Wrap each method in this._call()
     */
    _wrapMethods: function (info) {
        info = info || this.g_interface_info;

        let i, methods = info.methods;

        for (i = 0; i < methods.length; i++) {
            var method = methods[i];
            this[method.name] = this._wrapMethod(method.name);

            // TODO: construct parameter for casing?
            //log(this._toCamelCase(method.name));
            //this[this._toCamelCase(method.name)] = this._wrapMethod(method.name);
        }
    },

    /**
     * Wrap each property with this._get()/this._set() and call notify().
     * Properties can be handled before notify() is called by defining a method
     * called vprop_name().
     */
    _wrapProperties: function (info) {
        info = info || this.g_interface_info;

        if (info.properties.length > 0) {
            this.connect("g-properties-changed", (proxy, properties) => {
                for (let name in properties.deep_unpack()) {
                    // If the object has vprop_name(), call it before notify()
                    if (this["vprop_" + name]) {
                        debug("Calling 'vprop_" + name + "()' for " + name);
                        this["vprop_" + name].call(this);
                    }

                    this.notify(name);
                }
            });

            for (let property of info.properties) {
                let name = property.name;

                Object.defineProperty(this, name, {
                    get: () => this._get(name, property.signature),
                    set: (value) => this._set(name, value, property.signature),
                    configurable: true,
                    enumerable: true
                });
            }
        }
    },

    _wrapSignals: function (info) {
        info = info || this.g_interface_info;

        if (info.signals.length > 0) {
            this.connect("g-signal", (proxy, name, parameters) => {
                if (this.Signals[name]) {
                    let args = name.concat(parameters);

                    if (signalHandlers[name]) {
                        signalHandlers[name].call(this, ...args);
                    } else {
                        this.emit(...args);
                    }
                }
            });
        }
    },

    // TODO TODO
    _wrapObject: function () {
        let info = this.g_interface_info;

        this._wrapMethods(info);
        this._wrapProperties(info);
        this._wrapSignals(info);
    },

    // TODO: use this?
    _toCamelCase: function (string) {
        return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, idx) => {
            if (idx === 0) {
                return ltr.toLowerCase();
            } else {
                return ltr.toUpperCase();
            }
        }).replace(/\s+/g, '');
    },

    destroy: function () {
        GObject.signal_handlers_destroy(this);
    }
});

