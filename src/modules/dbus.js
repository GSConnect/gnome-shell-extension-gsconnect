"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gi = imports._gi;


function _makeOutSignature(args) {
    var ret = '(';
    for (var i = 0; i < args.length; i++)
        ret += args[i].signature;

    return ret + ')';
};


function variantToGType(types) {
    let gtypes = [];

    for (let char of types) {
        switch (char) {
            case "b":
                gtypes.push(GObject.TYPE_BOOLEAN);
                break;
            case "h" || "i":
                gtypes.push(GObject.TYPE_INT);
            case "u":
                gtypes.push(GObject.TYPE_UINT);
            case "x":
                gtypes.push(GObject.TYPE_INT64);
            case "t":
                gtypes.push(GObject.TYPE_UINT64);
            case "d":
                gtypes.push(GObject.TYPE_DOUBLE);
                break;
            case "s":
                gtypes.push(GObject.TYPE_STRING);
                break;
            case "y":
                gtypes.push(GObject.TYPE_UCHAR);
                break;
            // FIXME: assume it's a variant
            default:
                gtypes.push(GObject.TYPE_VARIANT);

        }
    }

    return gtypes;
};


/**
 * TODO: org.freedesktop.ObjectManager helpers
 */
function get_object_manager_client(params) {
    return new Promise((resolve, reject) => {
        let obj = Gio.DBusObjectManagerClient.new(
            params.g_connection,
            Gio.DBusObjectManagerClientFlags.NONE,
            params.g_name,
            params.g_object_path,
            params.proxyFunc,
            //_proxyTypeFunc, // FIXME
            null,
            (source_object, res) => {
                try {
                    source_object.new_finish(res);
                    resolve(obj);
                } catch(e) {
                    reject(e);
                }
            }
        );
    });
};


/**
 * ProxyServer represents a DBus interface bound to an object instance, meant
 * to be exported over DBus. It will automatically bind to all methods, signals
 * and properties (include notify::) defined in the interface and transforms
 * all members to TitleCase.
 */
var ProxyServer = new Lang.Class({
    Name: "GSConnectDBusProxyServer",
    Extends: GjsPrivate.DBusImplementation,
    Signals: {
        "destroy": {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    },

    _init: function (params) {
        this.parent({
            g_interface_info: params.g_interface_info
        });
        delete params.g_interface_info;

        this._g_interface_info = params.g_interface_info;
        this._exportee = params.g_instance;

        if (params.g_object_path) {
            this.g_object_path = params.g_object_path;
        }

        // Bind Object
        let info = this.get_info();

        this._exportMethods(info);
        this._exportProperties(info);
        this._exportSignals(info);

        // Export if connection and objec path were given
        if (params.g_connection && params.g_object_path) {
            this.export(
                params.g_connection,
                params.g_object_path
            );
        }
    },

    // HACK: for some reason the getter doesn't work properly on the parent
    get g_interface_info() {
        return this.get_info();
    },

    /**
     *
     */
    _call: function(info, methodName, parameters, invocation) {
        let properName = methodName.toCamelCase();
        properName = (this[properName]) ? properName : methodName.toUnderscoreCase();

        let retval;
        try {
            // FIXME: full unpack..?
            retval = this[properName].apply(this, parameters.deep_unpack());
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                let name = e.name;
                if (name.indexOf('.') < 0) {
                    // likely to be a normal JS error
                    name = 'org.gnome.gjs.JSError.' + name;
                }
                logError(e, "Exception in method call: " + methodName);
                invocation.return_dbus_error(name, e.message);
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
                let outArgs = info.lookup_method(methodName).out_args;
                retval = new GLib.Variant(
                    _makeOutSignature(outArgs),
                    (outArgs.length == 1) ? [retval] : retval
                );
            }
            invocation.return_value(retval);

        // Without a response, the client will wait for timeout
        } catch(e) {
            debug(e);
            invocation.return_dbus_error(
                "org.gnome.gjs.JSError.ValueError",
                "Service implementation returned an incorrect value type"
            );
        }
    },

    _exportMethods: function () {
        this.connect('handle-method-call', (impl, name, parameters, invocation) => {
            return this._call.call(
                this._exportee,
                this.g_interface_info,
                name,
                parameters,
                invocation
            );
        });
    },

    _get: function(info, propertyName) {
        // Look up the property info
        let propertyInfo = info.lookup_property(propertyName);
        // Convert to lower_underscore case before getting
        let value = this[propertyName.toUnderscoreCase()];

        // TODO: better pack
        if (value != undefined) {
            return new GLib.Variant(propertyInfo.signature, value);
        }

        return null;
    },

    _set: function(info, name, value) {
        // TODO: relies on 'gsconnect'
        value = gsconnect.full_unpack(value);
        //value = value.deep_unpack();

        if (!this._propertyCase) {
            if (this[name.toUnderscoreCase()]) {
                this._propertyCase = "toUnderScoreCase";
            } else if (this[name.toCamelCase()]) {
                this._propertyCase = "toCamelCase";
            }
        }

        // Convert to lower_underscore case before setting
        this[name[this._propertyCase]()] = value;
    },

    _exportProperties: function(info) {
        this.connect('handle-property-get', (impl, name) => {
            return this._get.call(
                this._exportee,
                this.g_interface_info,
                name
            );
        });

        this.connect('handle-property-set', (impl, name, value) => {
            return this._set.call(
                this._exportee,
                this.g_interface_info,
                name,
                value
            );
        });

        this._exportee.connect("notify", (obj, paramSpec) => {
            let name = paramSpec.name.toDBusCase();

            let propertyInfo = this.g_interface_info.lookup_property(name);

            if (propertyInfo) {
                this.emit_property_changed(
                    name,
                    new GLib.Variant(
                        propertyInfo.signature,
                        // Adjust for GJS's '-'/'_' conversion
                        this._exportee[paramSpec.name.replace(/[\-]+/g, "_")]
                    )
                );
            }
        });
    },

    _exportSignals: function (info) {
        for (let signal of info.signals) {
            this._exportee.connect(signal.name.toHyphenCase(), (obj, ...args) => {
                this.emit_signal(
                    signal.name,
                    new GLib.Variant(
                        "(" + signal.args.map(arg => arg.signature).join("") + ")",
                        args
                    )
                );
            });
        }
    },

    destroy: function() {
        this.emit("destroy");
        this.flush();
        this.unexport();
        GObject.signal_handlers_destroy(this);
    }
});


/**
 *
 */
var Proxies = {};


var ProxyBase = new Lang.Class({
    Name: "GSConnectDBusProxyBase",
    Extends: Gio.DBusProxy,
    Signals: {
        "destroy": {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    },

    _init: function (params) {
        this.flags = params.flags;
        delete params.flags;

        this.parent(Object.assign({
            g_connection: Gio.DBus.session
        }, params));

        this.cancellable = new Gio.Cancellable();
        this._proxyAll(this.g_interface_info);
    },

    init_promise: function () {
        return new Promise((resolve, reject) => {
            this.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, res) => {
                try {
                    proxy.init_finish(res);
                    resolve(proxy);
                } catch (e) {
                    reject(e);
                }
            });
        });
    },

    _call_sync: function (info) {
        // TODO: do this in _proxyMethod()???
        let args = Array.prototype.slice.call(arguments, 1);
        let signature = info.in_args.map(arg => arg.signature).join("");
        let variant = new GLib.Variant("(" + signature + ")", args);

        //
        let retval;

        try {
            let ret = this.call_sync(info.name, variant, 0, -1, null);
            retval = ret.deep_unpack();
        } catch (e) {
            log("Error calling '" + info.name + "': " + e.message);
            retval = undefined;
        }

        return retval;
    },

    _call: function (info) {
        return new Promise((resolve, reject) => {
            let args = Array.prototype.slice.call(arguments, 1);
            let signature = info.in_args.map(arg => arg.signature);
            let variant = new GLib.Variant("(" + signature.join("") + ")", args);

            this.call(info.name, variant, 0, -1, null, (proxy, result) => {
                let ret;

                try {
                    ret = this.call_finish(result);
                } catch (e) {
                    debug("Error calling " + info.name + ": " + e.message);
                    reject(e);
                }

                // If return has single arg, only return that or null
                if (info.out_args.length === 1) {
                    resolve((ret) ? ret.deep_unpack()[0] : null);
                // Otherwise return an array (possibly empty)
                } else {
                    resolve((ret) ? ret.deep_unpack() : []);
                }
            });
        });
    },

    /**
     * Synchronous Uncached Getter
     */
    _get: function (name, signature) {
        let variant;

        try {
            // Returns Variant('(v)')...
            variant = this.call_sync(
                "org.freedesktop.DBus.Properties.Get",
                new GLib.Variant("(ss)", [this.g_interface_name, name]),
                Gio.DBusCallFlags.NONE,
                -1,
                this.cancellable
            );

            // ...so unpack that to get the real variant and unpack the value
            return variant.deep_unpack()[0].deep_unpack();
        // Fallback to cached property...
        } catch (e) {
            debug("Failed to get: " + name + " on " + this.g_interface_name);
            debug("trying for cached property");

            try {
                return this.get_cached_property(name).deep_unpack();
            } catch (e) {
                debug(e);
                return null;
            }
        }
    },

    /**
     * Asynchronous Setter
     */
    _set: function (name, value, signature) {
        // Pack the new value
        let variant = new GLib.Variant(signature, value);

        // Set the cached property first
        this.set_cached_property(name, variant);

        // Let it run and just log any errors
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
                    log(
                        "Error setting " + name +
                        " on " + this.g_object_path + ": " +
                        e.message + "\n" + e.stack
                    );
                }
            }
        );
    },

    /**
     * Wrap a method in this._call()
     * @param {Gio.DBusMethodInfo} info - The interface expected to be
     *                                       implemented by this object
     */
    _proxyMethod: function (info) {
        return function () {
            return this._call.call(this, info, ...arguments);
        };
    },

    /**
     * Wrap each method in this._call()
     * @param {Gio.DBusInterfaceInfo} info - The interface expected to be
     *                                       implemented by this object
     */
    _proxyMethods: function (info) {
        let i, methods = info.methods;

        for (i = 0; i < methods.length; i++) {
            var method = methods[i];
            // TODO: Correct casing/guess?
            let properName = method.name.toCamelCase();
            this[properName] = this._proxyMethod(method);
        }
    },

    /**
     * Wrap each property with this._get()/this._set() and call notify();
     * requires each property to have a GObject.ParamSpec defined.
     *
     * @param {Gio.DBusInterfaceInfo} info - The interface expected to be
     *                                       implemented by this object
     */
    _proxyProperties: function(info) {
        if (info.properties.length > 0) {
            for (let property of info.properties) {
                let name = property.name;

                let properName = name.toUnderscoreCase();

                Object.defineProperty(this, properName, {
                    get: () => this._get(name, property.signature),
                    set: (value) => this._set(name, value, property.signature),
                    configurable: true,
                    enumerable: true
                });
            }

            this.connect("g-properties-changed", (proxy, properties) => {
                for (let name in properties.deep_unpack()) {
                    // Properties are set using lower_underscore...
                    let properName = name.toUnderscoreCase();
                    // but notify()'d using lower-hyphen
                    this.notify(name.toHyphenCase());
                }
            });
        }
    },

    /**
     * Wrap 'g-signal' with GObject.emit(); requires each signal to be defined
     * @param {Gio.DBusInterfaceInfo} info - The interface expected to be
     *                                       implemented by this object
     */
    _proxySignals: function(info) {
        if (info.signals.length > 0) {
            this.connect("g-signal", (proxy, sender, name, parameters) => {
                // Signals are emitted using lower-hyphen
                let properName = name.toHyphenCase();
                // FIXME: better unpack
                let args = [properName].concat(parameters.deep_unpack());
                this.emit(...args);
            });
        }
    },

    /**
     * Wrap all methods, properties and signals
     * @param {Gio.DBusInterfaceInfo} info - The interface expected to be
     *                                       implemented by this object
     */
    _proxyAll: function(info) {
        this._proxyMethods(info);
        this._proxyProperties(info);
        this._proxySignals(info);

        // FIXME FIXME FIXME
        // Destroy the proxy if the g_name_owner dies
        this.connect("notify::g-name-owner", () => {
            if (this.g_name_owner === null) {
                debug("NAME OWNER CHANGED: " + this.g_object_path + ":" + this.g_interface_name);
                //this.destroy();
            }
        });
    },

    destroy: function() {
        debug(this.g_interface_name);

        this.emit("destroy");
        GObject.signal_handlers_destroy(this);
    }
});


/**
 * Return a DBusProxy class prepped with GProperties, GSignals...
 * based on @info
 * @param {Gio.DBusInterfaceInfo} info - The supported interface
 */
function makeInterfaceProxy(info) {
    if (Proxies.hasOwnProperty(info.name)) {
        return Proxies[info.name];
    }

    // Properties
    let properties_ = {};

    for (let i = 0; i < info.properties.length; i++) {
        let property = info.properties[i]
        let proxyName = property.name.toHyphenCase();
        let flags = 0;

        if (property.flags & Gio.DBusPropertyInfoFlags.READABLE) {
            flags |= GObject.ParamFlags.READABLE;
        }

        if (property.flags & Gio.DBusPropertyInfoFlags.WRITABLE) {
            flags |= GObject.ParamFlags.WRITABLE;
        }

        if (property.signature === "b") {
            properties_[proxyName] = GObject.ParamSpec.boolean(
                proxyName,
                property.name,
                property.name + ": automatically populated",
                flags,
                false
            );
        } else if ("sog".indexOf(property.signature) > -1) {
            properties_[proxyName] = GObject.ParamSpec.string(
                proxyName,
                property.name,
                property.name + ": automatically populated",
                flags,
                ""
            );
        // TODO: all number types are converted to Number which is a double,
        //       but there may be a case where type is relevant on the proxy
        } else if ("hiuxtd".indexOf(property.signature) > -1) {
            properties_[proxyName] = GObject.ParamSpec.double(
                proxyName,
                property.name,
                property.name + ": automatically populated",
                flags,
                GLib.MININT32, GLib.MAXINT32,
                0.0
            );
        } else {
            properties_[proxyName] = GObject.param_spec_variant(
                proxyName,
                property.name,
                property.name + ": automatically populated",
                new GLib.VariantType(property.signature),
                null,
                flags
            );
        }
    }

    // Signals
    let signals_ = {};

    for (let i = 0; i < info.signals.length; i++) {
        let signal = info.signals[i];

        signals_[signal.name.toHyphenCase()] = {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: variantToGType(signal.args.map(arg => arg.signature).join(""))
        };
    }

    // Register and store the proxy class to avoid more work or GType collisions
    Proxies[info.name] = new Lang.Class({
        Name: "Proxy_" + info.name.split(".").join(""),
        Extends: ProxyBase,
        Properties: properties_,
        Signals: signals_,

        _init: function (params) {
            this.parent(Object.assign({
                g_connection: Gio.DBus.session,
                g_interface_info: info,
                g_interface_name: info.name
            }, params));
        }
    });

    return Proxies[info.name];
};


/**
 * org.freedesktop.DBus Proxy and ProxyBase usage example
 */
const FdoNode = Gio.DBusNodeInfo.new_for_xml(
'<node> \
  <interface name="org.freedesktop.DBus"> \
    <method name="Hello"> \
      <arg direction="out" type="s"/> \
    </method> \
    <method name="RequestName"> \
      <arg direction="in" type="s"/> \
      <arg direction="in" type="u"/> \
      <arg direction="out" type="u"/> \
    </method> \
    <method name="ReleaseName"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="u"/> \
    </method> \
    <method name="StartServiceByName"> \
      <arg direction="in" type="s"/> \
      <arg direction="in" type="u"/> \
      <arg direction="out" type="u"/> \
    </method> \
    <method name="UpdateActivationEnvironment"> \
      <arg direction="in" type="a{ss}"/> \
    </method> \
    <method name="NameHasOwner"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="b"/> \
    </method> \
    <method name="ListNames"> \
      <arg direction="out" type="as"/> \
    </method> \
    <method name="ListActivatableNames"> \
      <arg direction="out" type="as"/> \
    </method> \
    <method name="AddMatch"> \
      <arg direction="in" type="s"/> \
    </method> \
    <method name="RemoveMatch"> \
      <arg direction="in" type="s"/> \
    </method> \
    <method name="GetNameOwner"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="s"/> \
    </method> \
    <method name="ListQueuedOwners"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="as"/> \
    </method> \
    <method name="GetConnectionUnixUser"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="u"/> \
    </method> \
    <method name="GetConnectionUnixProcessID"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="u"/> \
    </method> \
    <method name="GetAdtAuditSessionData"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="ay"/> \
    </method> \
    <method name="GetConnectionSELinuxSecurityContext"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="ay"/> \
    </method> \
    <method name="GetConnectionAppArmorSecurityContext"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="s"/> \
    </method> \
    <method name="ReloadConfig"> \
    </method> \
    <method name="GetId"> \
      <arg direction="out" type="s"/> \
    </method> \
    <method name="GetConnectionCredentials"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="a{sv}"/> \
    </method> \
    <signal name="NameOwnerChanged"> \
      <arg type="s"/> \
      <arg type="s"/> \
      <arg type="s"/> \
    </signal> \
    <signal name="NameLost"> \
      <arg type="s"/> \
    </signal> \
    <signal name="NameAcquired"> \
      <arg type="s"/> \
    </signal> \
  </interface> \
  <interface name="org.freedesktop.DBus.Monitoring"> \
    <method name="BecomeMonitor"> \
      <arg direction="in" type="as"/> \
      <arg direction="in" type="u"/> \
    </method> \
  </interface> \
</node>'
);


/**
 * Proxy for org.freedesktop.DBus Interface
 */
var FdoProxy = makeInterfaceProxy(
    FdoNode.lookup_interface("org.freedesktop.DBus")
);

// TODO not used?
var FdoMonitoringProxy = makeInterfaceProxy(
    FdoNode.lookup_interface("org.freedesktop.DBus.Monitoring")
);


/**
 * Implementing a singleton
 */
var _default;

function get_default() {
    if (!_default) {
        _default = new FdoProxy({
            g_connection: Gio.DBus.session,
            g_name: "org.freedesktop.DBus",
            g_object_path: "/"
        });

        _default.init_promise().then(result => {
            return _default;
        }).catch(e => debug(e));
    } else {
        return _default;
    }
};

