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
            let signature = [];
            let i, ret;

            for (i = 0; i < methodInfo.in_args.length; i++) {
                signature.push(methodInfo.in_args[i].signature);
            }

            let variant = new GLib.Variant("(" + signature.join("") + ")", args);

            this.call(name, variant, 0, -1, null, (proxy, result) => {
                let succeeded = false;

                try {
                    ret = this.call_finish(result);
                } catch (e) {
                    log("Error calling " + name + ": " + e.message);
                    reject(e);
                }

                // If return has single arg, only return that
                if (methodInfo.out_args.length === 1) {
                    resolve((ret) ? ret.deep_unpack()[0] : null);
                } else {
                    resolve((ret) ? ret.deep_unpack() : null);
                }
            });
        });
    },

    _get: function (name, signature) {
        let value = this.get_cached_property(name);

        if (!value) {
            signature = signature || this.g_interface_info.lookup_property(name).signature;
            //
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

    _set: function (name, value, signature) {
        if (!signature) {
            let propertyInfo = this.gInterfaceInfo.lookup_property(name);
            let variant = new GLib.Variant(propertyInfo.signature, value);
        }

        // Set the cached property first
        this.set_cached_property(name, variant);

        this.call(
            "org.freedesktop.DBus.Properties.Set",
            new GLib.Variant("(ssv)", [this.gInterfaceName, name, variant]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable,
            (proxy, result) => {
                try {
                    this.call_finish(result);
                } catch (e) {
                    log(
                        "Error setting " + name +
                        " on " + this.gObjectPath +
                        ": " + e.message
                    );
                }
            }
        );
    },

    _getMethodSignature: function (name) {
        let methodInfo = this.gInterfaceInfo.lookup_method(name);
        let signature = [];
        let i, ret;

        for (i = 0; i < methodInfo.in_args.length; i++) {
            signature.push(methodInfo.in_args[i].signature);
        }

        return signature;
    },

    _wrapMethod: function (name) {
        return function () {
            return this._call.call(this, name, arguments);
        };
    },

    _wrapProperties: function (handlers={}) {
        let info = this.g_interface_info;

        if (info.properties.length > 0) {
            this.connect("g-properties-changed", (proxy, properties) => {
                for (let name in properties.deep_unpack()) {
                    if (handlers[name]) {
                        debug("Calling " + name + " handler");
                        handlers[name].call(this);
                    } else {
                        this.notify(name);
                    }
                }
            });

            for (let property of info.properties) {
                let name = property.name;
                let signature = property.signature;

                Object.defineProperty(this, name, {
                    get: () => this._get(name, signature),
                    set: (value) => this._set(name, value, signature),
                    configurable: true,
                    enumerable: true
                });
            }
        }
    },

    // TODO TODO
    _wrapObject: function (propertyHandlers, signalHandlers) {

        let i, methods = info.methods;

        for (i = 0; i < methods.length; i++) {
            var method = methods[i];
            log(this._toCamelCase(method.name));
            this[this._toCamelCase(method.name)] = this._wrapMethod(method.name);
//            this[method.name + 'Remote'] = _makeProxyMethod(methods[i], false);
//            this[method.name + 'Sync'] = _makeProxyMethod(methods[i], true);
        }

        // Properties
        this._wrapProperties(handlers);

        // Signals
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

