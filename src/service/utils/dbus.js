'use strict';

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/*
 * Some utility methods
 */
function toDBusCase(string) {
    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
}

function toHyphenCase(string) {
    return string.replace(/(?:[A-Z])/g, (ltr, offset) => {
        return (offset > 0) ? `-${ltr.toLowerCase()}` : ltr.toLowerCase();
    }).replace(/[\s_]+/g, '');
}

function toUnderscoreCase(string) {
    return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
        if (ltr === '_')
            return '';

        return (offset > 0) ? `_${ltr.toLowerCase()}` : ltr.toLowerCase();
    }).replace(/[\s-]+/g, '');
}


/**
 * DBus.Interface represents a DBus interface bound to an object instance, meant
 * to be exported over DBus.
 */
var Interface = GObject.registerClass({
    GTypeName: 'GSConnectDBusInterface',
    Implements: [Gio.DBusInterface],
    Properties: {
        'g-instance': GObject.ParamSpec.object(
            'g-instance',
            'Instance',
            'The delegate GObject',
            GObject.ParamFlags.READWRITE,
            GObject.Object.$gtype
        ),
    },
}, class Interface extends GjsPrivate.DBusImplementation {

    _init(params) {
        super._init({
            g_instance: params.g_instance,
            g_interface_info: params.g_interface_info,
        });

        // Cache member lookups
        this._instanceHandlers = [];
        this._instanceMethods = {};
        this._instanceProperties = {};

        const info = this.get_info();
        this.connect('handle-method-call', this._call.bind(this._instance, info));
        this.connect('handle-property-get', this._get.bind(this._instance, info));
        this.connect('handle-property-set', this._set.bind(this._instance, info));

        // Automatically forward known signals
        const id = this._instance.connect('notify', this._notify.bind(this));
        this._instanceHandlers.push(id);

        for (const signal of info.signals) {
            const type = `(${signal.args.map(arg => arg.signature).join('')})`;
            const id = this._instance.connect(
                signal.name,
                this._emit.bind(this, signal.name, type)
            );

            this._instanceHandlers.push(id);
        }

        // Export if connection and object path were given
        if (params.g_connection && params.g_object_path)
            this.export(params.g_connection, params.g_object_path);
    }

    get g_instance() {
        if (this._instance === undefined)
            this._instance = null;

        return this._instance;
    }

    set g_instance(instance) {
        this._instance = instance;
    }

    /**
     * Invoke an instance's method for a DBus method call.
     *
     * @param {Gio.DBusInterfaceInfo} info - The DBus interface
     * @param {DBus.Interface} iface - The DBus interface
     * @param {string} name - The DBus method name
     * @param {GLib.Variant} parameters - The method parameters
     * @param {Gio.DBusMethodInvocation} invocation - The method invocation info
     */
    async _call(info, iface, name, parameters, invocation) {
        let retval;

        // Invoke the instance method
        try {
            const args = parameters.unpack().map(parameter => {
                if (parameter.get_type_string() === 'h') {
                    const message = invocation.get_message();
                    const fds = message.get_unix_fd_list();
                    const idx = parameter.deepUnpack();
                    return fds.get(idx);
                } else {
                    return parameter.recursiveUnpack();
                }
            });

            retval = await this[name](...args);
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                // likely to be a normal JS error
                if (!e.name.includes('.'))
                    e.name = `org.gnome.gjs.JSError.${e.name}`;

                invocation.return_dbus_error(e.name, e.message);
            }

            logError(e, `${this}: ${name}`);
            return;
        }

        // `undefined` is an empty tuple on DBus
        if (retval === undefined)
            retval = new GLib.Variant('()', []);

        // Return the instance result or error
        try {
            if (!(retval instanceof GLib.Variant)) {
                const args = info.lookup_method(name).out_args;
                retval = new GLib.Variant(
                    `(${args.map(arg => arg.signature).join('')})`,
                    (args.length === 1) ? [retval] : retval
                );
            }

            invocation.return_value(retval);
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.gjs.JSError.ValueError',
                'Service implementation returned an incorrect value type'
            );

            logError(e, `${this}: ${name}`);
        }
    }

    _nativeProp(obj, name) {
        if (this._instanceProperties[name] === undefined) {
            let propName = name;

            if (propName in obj)
                this._instanceProperties[name] = propName;

            if (this._instanceProperties[name] === undefined) {
                propName = toUnderscoreCase(name);

                if (propName in obj)
                    this._instanceProperties[name] = propName;
            }
        }

        return this._instanceProperties[name];
    }

    _emit(name, type, obj, ...args) {
        this.emit_signal(name, new GLib.Variant(type, args));
    }

    _get(info, iface, name) {
        const nativeValue = this[iface._nativeProp(this, name)];
        const propertyInfo = info.lookup_property(name);

        if (nativeValue === undefined || propertyInfo === null)
            return null;

        return new GLib.Variant(propertyInfo.signature, nativeValue);
    }

    _set(info, iface, name, value) {
        const nativeValue = value.recursiveUnpack();

        this[iface._nativeProp(this, name)] = nativeValue;
    }

    _notify(obj, pspec) {
        const name = toDBusCase(pspec.name);
        const propertyInfo = this.get_info().lookup_property(name);

        if (propertyInfo === null)
            return;

        this.emit_property_changed(
            name,
            new GLib.Variant(
                propertyInfo.signature,
                // Adjust for GJS's '-'/'_' conversion
                this._instance[pspec.name.replace(/-/gi, '_')]
            )
        );
    }

    destroy() {
        try {
            for (const id of this._instanceHandlers)
                this._instance.disconnect(id);
            this._instanceHandlers = [];

            this.flush();
            this.unexport();
        } catch (e) {
            logError(e);
        }
    }
});


/**
 * Get the DBus connection on @busType
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param {Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 * @return {Promise<Gio.DBusConnection>} A DBus connection
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
 * Get a new, dedicated DBus connection on @busType
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param {Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 * @return {Promise<Gio.DBusConnection>} A new DBus connection
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

