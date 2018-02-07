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
        this._wrapObject();
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
     * Synchronous Uncached Getter
     */
    _get: function (name, signature) {
        // Return '(v)'
        let variant = this.call_sync(
            "org.freedesktop.DBus.Properties.Get",
            new GLib.Variant("(ss)", [this.g_interface_name, name]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );
        // So unpack that to get the real variant...
        variant = variant.deep_unpack()[0];
        // signature...
        signature = signature || variant.get_type_string();
        // and value
        let value = variant.deep_unpack();

        // FIXME ...
        if (!variant) {
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
            return value || null;
        }
    },

    /**
     * Asynchronous Setter
     */
    _set: function (name, value, signature) {
        signature = signature || this.g_nterface_info.lookup_property(name).signature
        let variant = new GLib.Variant(signature, value);

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
            this.connect("g-signal", (proxy, sender, name, parameters) => {
                let args = [name].concat(parameters.deep_unpack());
                this.emit(...args);
            });
        }
    },

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
  <interface name="org.freedesktop.DBus.Introspectable"> \
    <method name="Introspect"> \
      <arg direction="out" type="s"/> \
    </method> \
  </interface> \
  <interface name="org.freedesktop.DBus.Monitoring"> \
    <method name="BecomeMonitor"> \
      <arg direction="in" type="as"/> \
      <arg direction="in" type="u"/> \
    </method> \
  </interface> \
  <interface name="org.freedesktop.DBus.Debug.Stats"> \
    <method name="GetStats"> \
      <arg direction="out" type="a{sv}"/> \
    </method> \
    <method name="GetConnectionStats"> \
      <arg direction="in" type="s"/> \
      <arg direction="out" type="a{sv}"/> \
    </method> \
    <method name="GetAllMatchRules"> \
      <arg direction="out" type="a{sas}"/> \
    </method> \
  </interface> \
</node>'
);
const FdoIface = FdoNode.lookup_interface("org.freedesktop.DBus");
const MonitoringIface = FdoNode.lookup_interface("org.freedesktop.DBus.Monitoring");


/**
 * Implementing a singleton
 */
var _default;

function get_default() {
    if (!_default) {
        _default = new FdoProxy();
    }

    return _default;
};


/**
 * Proxy for org.freedesktop.DBus Interface
 */
var FdoProxy = new Lang.Class({
    Name: "GSConnectFdoProxy",
    Extends: ProxyBase,
    Properties: {
        // A custom property for the org.freedesktop.DBus.Monitoring interface
        "Monitoring": GObject.ParamSpec.object(
            "Monitoring",
            "Monitoring Interface",
            "A DBus proxy for org.freedesktop.DBus.Monitoring",
            GObject.ParamFlags.READABLE,
            Gio.DBusProxy
        )
    },
    Signals: {
        "NameOwnerChanged": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING, // Name
                GObject.TYPE_STRING, // Old owner
                GObject.TYPE_STRING // New owner
            ]
        },
        "NameLost": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ] // Name
        },
        "NameAcquired": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ] // Name
        }
    },

    _init: function () {
        this.parent({
            g_connection: Gio.DBus.session,
            g_interface_info: FdoIface,
            g_interface_name: FdoIface.name,
            g_name: "org.freedesktop.DBus",
            g_object_path: "/"
        });
    },

    get Monitoring() {
        if (!this._Monitoring) {
            this._Monitoring = new ProxyBase({
                g_connection: Gio.DBus.session,
                g_interface_info: MonitoringIface,
                g_interface_name: MonitoringIface.name,
                g_name: "org.freedesktop.DBus",
                g_object_path: "/"
            });
        }

        return this._Monitoring;
    }
});

