// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';


/*
 * Some utility methods
 */

/**
 * Convert a label from kebab-case to CamelCase.
 * Will also remove snake_case separators (without capitalizing)
 *
 * @param {string} string - The label to reformat
 * @returns {string} The CamelCased label
 */
function toDBusCase(string) {
    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
}

/**
 * Convert a label from CamelCase to snake_case.
 *
 * @param {string} string - The label to reformat
 * @returns {string} - The snake_cased label
 */
function toUnderscoreCase(string) {
    return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
        if (ltr === '_')
            return '';

        return (offset > 0) ? `_${ltr.toLowerCase()}` : ltr.toLowerCase();
    }).replace(/[\s-]+/g, '');
}

/**
 * Creates a DBus interface which performs property get/set and method
 * calls on the an GObject, using the `Gio.DBusExportedObject.wrapJSObject`
 * convenience helper from GJS.
 *
 * On top of the convenience helper, handle translating DBus-style property
 * names to JS-style names, emitting property changed signals to DBus, and
 * emitting DBus interface signals.
 *
 * @param {Gio.DBusInterfaceInfo} interfaceInfo - The info for a DBus interface
 * @param {GObject.Object} obj - The object with DBus properties and methods
 * @returns {Gio.DBusExportedObject} - The DBus interface
 */
export function wrapObject(interfaceInfo, obj) {
    // Intercept property get/set on the object to translate property names to
    // JS-style names if necessary.
    const proxyObj = new Proxy(
        obj,
        {
            get(target, prop, receiver) {
                const value = Reflect.has(target, prop)
                    ? Reflect.get(target, prop)
                    : Reflect.get(target, toUnderscoreCase(prop));

                // `this` should not be pointing at Proxy
                if (typeof value === 'function')
                    return value.bind(target);

                return value;
            },
            set(target, prop, newValue, receiver) {
                return Reflect.has(target, prop)
                    ? Reflect.set(target, prop, newValue)
                    : Reflect.set(target, toUnderscoreCase(prop), newValue);
            },
        }
    );
    const impl = Gio.DBusExportedObject.wrapJSObject(interfaceInfo, proxyObj);

    // Automatically forward known signals
    obj.connect(
        'notify',
        (_, pspec) => {
            const name = toDBusCase(pspec.name);
            const propertyInfo = interfaceInfo.lookup_property(name);

            if (propertyInfo === null)
                return;

            impl.emit_property_changed(
                name,
                new GLib.Variant(
                    propertyInfo.signature,
                    // Adjust for GJS's '-'/'_' conversion
                    obj[pspec.name.replace(/-/gi, '_')]
                )
            );
        }
    );

    for (const signal of interfaceInfo.signals) {
        const type = `(${signal.args.map(arg => arg.signature).join('')})`;
        obj.connect(
            signal.name,
            (_, ...args) => {
                impl.emit_signal(signal.name, new GLib.Variant(type, args));
            }
        );
    }

    return impl;
}

/**
 * Get a new, dedicated DBus connection on {@link busType}
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param {Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 * @returns {Promise<Gio.DBusConnection>} A new DBus connection
 */
export function newConnection(busType = Gio.BusType.SESSION, cancellable = null) {
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
