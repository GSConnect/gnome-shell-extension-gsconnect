'use strict';

const Gi = imports._gi;
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


function _makeOutSignature(args) {
    var ret = '(';
    for (var i = 0; i < args.length; i++)
        ret += args[i].signature;

    return ret + ')';
};


function dbus_variant_to_gtype(types) {
    let gtypes = [];

    for (let i = 0; i < types.length; i++) {
        switch (types[i]) {
            case 'b':
                gtypes.push(GObject.TYPE_BOOLEAN);
                break;
            case 'h' || 'i':
                gtypes.push(GObject.TYPE_INT);
            case 'u':
                gtypes.push(GObject.TYPE_UINT);
            case 'x':
                gtypes.push(GObject.TYPE_INT64);
            case 't':
                gtypes.push(GObject.TYPE_UINT64);
            case 'd':
                gtypes.push(GObject.TYPE_DOUBLE);
                break;
            case 's':
                gtypes.push(GObject.TYPE_STRING);
                break;
            case 'y':
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
 * DBus.Interface represents a DBus interface bound to an object instance, meant
 * to be exported over DBus. It will automatically bind to all methods, signals
 * and properties (include notify::) defined in the interface and transforms
 * all members to TitleCase.
 */
var Interface = GObject.registerClass({
    GTypeName: 'GSConnectDBusInterface',
    Signals: {
        'destroy': {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    }
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
            this.export(
                params.g_connection,
                params.g_object_path
            );
        }
    }

    // HACK: for some reason the getter doesn't work properly on the parent
    get g_interface_info() {
        return this.get_info();
    }

    /**
     *
     */
    _call(info, memberName, parameters, invocation) {
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
            let params = parameters.unpack().map(parameter => {
                if (parameter.get_type_string() === 'h') {
                    let fds = invocation.get_message().get_unix_fd_list();
                    let idx = parameter.deep_unpack();
                    return fds.get(idx);
                } else {
                    return gsconnect.full_unpack(parameter);
                }
            });

            retval = this[nativeName].apply(this, params);
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                let name = e.name;
                if (name.indexOf('.') < 0) {
                    // likely to be a normal JS error
                    name = 'org.gnome.gjs.JSError.' + name;
                }
                logError(e, 'Exception in method call: ' + memberName);
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
                let outArgs = info.lookup_method(memberName).out_args;
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
                'org.gnome.gjs.JSError.ValueError',
                'Service implementation returned an incorrect value type'
            );
        }
    }

    _exportMethods() {
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
        value = gsconnect.full_unpack(value);

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
                        this._exportee[paramSpec.name.replace(/[\-]+/g, '_')]
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
        this.emit('destroy');
        this.flush();
        this.unexport();
        GObject.signal_handlers_destroy(this);
    }
});


/**
 *
 */

/**
 * Create proxy wrappers for the properties on an interface
 */
function _proxyGetter(name) {
    let variant;

    try {
        // Returns Variant('(v)')...
        variant = this.call_sync(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [this.g_interface_name, name]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );

        // ...so unpack that to get the real variant and unpack the value
        return variant.deep_unpack()[0].deep_unpack();
    // Fallback to cached property...
    } catch (e) {
        let value = this.get_cached_property(name);
        return value ? value.deep_unpack() : null;
    }
}


function _proxySetter(name, signature, value) {
    // Pack the new value
    let variant = new GLib.Variant(signature, value);

    // Set the cached property first
    this.set_cached_property(name, variant);

    // Let it run and just log any errors
    this.call(
        'org.freedesktop.DBus.Properties.Set',
        new GLib.Variant('(ssv)', [this.g_interface_name, name, variant]),
        Gio.DBusCallFlags.NONE,
        -1,
        this.cancellable,
        (proxy, result) => {
            try {
                this.call_finish(result);
            } catch (e) {
                log(`Error setting ${name} on ${this.g_object_path}: ${e.message}`);
            }
        }
    );
}


function proxyProperties(iface, info) {
    info.properties.map(property => {
        Object.defineProperty(iface, property.name, {
            get: _proxyGetter.bind(iface, property.name),
            set: _proxyGetter.bind(iface, property.name, property.signature),
            enumerable: true
        });
    });
}


/**
 * Create proxy wrappers for the methods on an interface
 */
function _proxyInvoker(info) {
    let args = Array.prototype.slice.call(arguments, 1);
    let signature = info.in_args.map(arg => arg.signature).join('');
    let variant = new GLib.Variant(`(${signature})`, args);

    //
    let retval;

    try {
        let ret = this.call_sync(info.name, variant, 0, -1, null);
        retval = ret.deep_unpack();
    } catch (e) {
        debug(`Error calling ${info.name} on ${this.g_object_path}: ${e.message}`);
        retval = undefined;
    }

    return retval;
}


function _proxyInvokerAsync(info) {
    return new Promise((resolve, reject) => {
        let args = Array.prototype.slice.call(arguments, 1);
        let signature = info.in_args.map(arg => arg.signature).join('');
        let variant = new GLib.Variant(`(${signature})`, args);

        this.call(info.name, variant, 0, -1, null, (proxy, result) => {
            let ret;

            try {
                ret = this.call_finish(result);
            } catch (e) {
                debug(`Error calling ${info.name} on ${this.g_object_path}: ${e.message}`);
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
}


function proxyMethods(iface, info) {
    let i, methods = info.methods;

    for (i = 0; i < methods.length; i++) {
        var method = methods[i];
        iface[method.name] = _proxyInvokerAsync.bind(iface, method);
        iface[`${method.name}Sync`] = _proxyInvoker.bind(iface, method);
    }
}


var Proxies = {};


var ProxyBase = GObject.registerClass({
    GTypeName: 'GSConnectDBusProxyBase',
    Signals: {
        'destroy': {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    }
}, class ProxyBase extends Gio.DBusProxy {

    _init(params) {
        super._init(Object.assign({
            g_connection: Gio.DBus.session
        }, params));

        this.cancellable = new Gio.Cancellable();

        // Proxy all members
        let info = this.g_interface_info;

        proxyMethods(this, info);
        proxyProperties(this, info);

        // Destroy the proxy if the g_name_owner dies
        this.connect('notify::g-name-owner', () => {
            if (this.g_name_owner === null) {
                debug(`NAME OWNER CHANGED: ${this.g_object_path}: ${this.g_interface_name}`);
            }
        });
    }

    init_promise() {
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
    }

    _call(info) {
        return new Promise((resolve, reject) => {
            let args = Array.prototype.slice.call(arguments, 1);
            let signature = info.in_args.map(arg => arg.signature).join('');
            let variant = new GLib.Variant(`(${signature})`, args);

            this.call(info.name, variant, 0, -1, null, (proxy, result) => {
                let ret;

                try {
                    ret = this.call_finish(result);
                } catch (e) {
                    debug(`Error calling ${info.name} on ${this.g_object_path}: ${e.message}`);
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
    }

    /**
     * Wrap a method in this._call()
     * @param {Gio.DBusMethodInfo} info - The interface expected to be
     *                                    implemented by this object
     */
    _proxyMethod(info) {
        return function () {
            return this._call.call(this, info, ...arguments);
        };
    }

    destroy() {
        debug(this.g_interface_name);

        this.emit('destroy');
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

    // GProperty ParamSpec's
    let properties_ = {};

    for (let i = 0; i < info.properties.length; i++) {
        let property = info.properties[i]
        let flags = 0;

        if (property.flags & Gio.DBusPropertyInfoFlags.READABLE) {
            flags |= GObject.ParamFlags.READABLE;
        }

        if (property.flags & Gio.DBusPropertyInfoFlags.WRITABLE) {
            flags |= GObject.ParamFlags.WRITABLE;
        }

        if (property.signature === 'b') {
            properties_[property.name] = GObject.ParamSpec.boolean(
                property.name,
                property.name,
                property.name + ': automatically populated',
                flags,
                false
            );
        } else if ('sog'.indexOf(property.signature) > -1) {
            properties_[property.name] = GObject.ParamSpec.string(
                property.name,
                property.name,
                property.name + ': automatically populated',
                flags,
                ''
            );
        // TODO: all number types are converted to Number which is a double,
        //       but there may be a case where type is relevant on the proxy
        } else if ('hiuxtd'.indexOf(property.signature) > -1) {
            properties_[property.name] = GObject.ParamSpec.double(
                property.name,
                property.name,
                property.name + ': automatically populated',
                flags,
                GLib.MININT32, GLib.MAXINT32,
                0.0
            );
        } else {
            properties_[property.name] = GObject.param_spec_variant(
                property.name,
                property.name,
                property.name + ': automatically populated',
                new GLib.VariantType(property.signature),
                null,
                flags
            );
        }
    }

    // GSignal Spec's
    let signals_ = {};

    for (let i = 0; i < info.signals.length; i++) {
        let signal = info.signals[i];

        signals_[signal.name] = {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: dbus_variant_to_gtype(signal.args.map(arg => arg.signature).join(''))
        };
    }

    // Register and store the proxy class to avoid more work or GType collisions
    Proxies[info.name] = GObject.registerClass({
        GTypeName: 'Proxy_' + info.name.split('.').join(''),
        Properties: properties_,
        Signals: signals_
    }, class ProxyExtension extends ProxyBase {

        _init(params) {
            super._init(Object.assign({
                g_connection: Gio.DBus.session,
                g_interface_info: info,
                g_interface_name: info.name
            }, params));

            this.connect('g-properties-changed', (proxy, properties) => {
                for (let name in properties.deep_unpack()) {
                    proxy.notify(name);
                }
            });

            this.connect('g-signal', (proxy, sender, name, parameters) => {
                let args = [name].concat(parameters.deep_unpack());
                this.emit(...args);
            });
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
    FdoNode.lookup_interface('org.freedesktop.DBus')
);

// TODO not used?
var FdoMonitoringProxy = makeInterfaceProxy(
    FdoNode.lookup_interface('org.freedesktop.DBus.Monitoring')
);


/**
 * Implementing a singleton
 */
var _default;

function get_default() {
    if (!_default) {
        _default = new FdoProxy({
            g_connection: Gio.DBus.session,
            g_name: 'org.freedesktop.DBus',
            g_object_path: '/'
        });
        _default.init(null);
    }

    return _default;
};

