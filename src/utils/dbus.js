'use strict';

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Some utility methods
 */
function toCamelCase(string) {
    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return (offset === 0) ? ltr.toLowerCase() : ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
}

function toDBusCase(string) {
    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
}

function toHyphenCase(string) {
    return string.replace(/(?:[A-Z])/g, (ltr, offset) => {
        return (offset > 0) ? '-' + ltr.toLowerCase() : ltr.toLowerCase();
    }).replace(/[\s_]+/g, '');
}

function toUnderscoreCase(string) {
    return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
        if (ltr === '_') return '';
        return (offset > 0) ? '_' + ltr.toLowerCase() : ltr.toLowerCase();
    }).replace(/[\s-]+/g, '');
}


/**
 * Build a GVariant type string from an method argument list.
 */
function _makeOutSignature(args) {
    var ret = '(';
    for (var i = 0; i < args.length; i++)
        ret += args[i].signature;

    return ret + ')';
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

        if (this[memberName] !== undefined) {
            nativeName = memberName;
        } else if (this[toUnderscoreCase(memberName)] !== undefined) {
            nativeName = toUnderscoreCase(memberName);
        } else if (this[toCamelCase(memberName)] !== undefined) {
            nativeName = toCamelCase(memberName);
        }

        let retval;

        try {
            parameters = parameters.unpack().map(parameter => {
                if (parameter.get_type_string() === 'h') {
                    let message = invocation.get_message();
                    let fds = message.get_unix_fd_list();
                    let idx = parameter.deepUnpack();
                    return fds.get(idx);
                } else {
                    return parameter.recursiveUnpack();
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
        if (info.methods.length === 0) return;

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
        let propertyInfo = info.lookup_property(propertyName);
        let value;

        // Check before assuming native DBus case
        if (this[propertyName] !== undefined) {
            value = this[propertyName];
        } else {
            value = this[toUnderscoreCase(propertyName)];
        }

        if (value !== undefined) {
            return new GLib.Variant(propertyInfo.signature, value);
        } else {
            return null;
        }
    }

    _set(info, name, value) {
        let nativeValue = value.recursiveUnpack();

        if (this[name] !== undefined) {
            this[name] = nativeValue;
            return;
        }

        if (!this._nativeCase) {
            if (this[toUnderscoreCase(name)] !== undefined) {
                this._nativeCase = toUnderscoreCase;
            } else if (this[toCamelCase(name)] !== undefined) {
                this._nativeCase = toCamelCase;
            }
        }

        this[this._nativeCase(name)] = nativeValue;
    }

    _exportProperties(info) {
        if (info.properties.length === 0) return;

        this.connect('handle-property-get', (impl, name) => {
            return this._get.call(this._exportee, info, name);
        });

        this.connect('handle-property-set', (impl, name, value) => {
            return this._set.call(this._exportee, info, name, value);
        });

        this._exportee.connect('notify', (obj, paramSpec) => {
            let name = toDBusCase(paramSpec.name);
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
            this._exportee.connect(signal.name, (obj, ...args) => {
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
        if (this.__disposed === undefined) {
            this.__disposed = true;

            this.flush();
            this.unexport();
            this.run_dispose();
        }
    }
});


/**
 * Get the DBus connection on @busType
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param (Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 */
function getConnection(busType = Gio.BusType.SESSION, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.bus_get(busType, cancellable, (connection, res) => {
            try {
                resolve(Gio.bus_get_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Get a new dedicated DBus connection on @busType
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param (Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 */
function newConnection(busType = Gio.BusType.SESSION, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.DBusConnection.new_for_address(
            Gio.dbus_address_get_for_bus_sync(busType, cancellable),
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null,
            cancellable,
            (connection, res) => {
                try {
                    resolve(Gio.DBusConnection.new_for_address_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );

    });
}

