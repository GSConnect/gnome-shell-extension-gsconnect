'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


const DEVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect.Device';
const DEVICE_INFO = gsconnect.dbusinfo.lookup_interface(DEVICE_NAME);


var Service = GObject.registerClass({
    GTypeName: 'GSConnectRemoteService',
    Implements: [Gio.DBusInterface],
    Signals: {
        'available-changed': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'device-added': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_OBJECT]
        },
        'device-removed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_OBJECT]
        }
    }
}, class Service extends Gio.DBusProxy {

    _init() {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.gnome.Shell.Extensions.GSConnect',
            g_object_path: '/org/gnome/Shell/Extensions/GSConnect',
            g_interface_name: 'org.freedesktop.DBus.ObjectManager',
            g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION
        });

        this._devices = new Map();

        // Watch the service
        this._nameOwnerChangedId = this.connect(
            'notify::g-name-owner',
            this._onNameOwnerChanged.bind(this)
        );
    }

    async _init_async() {
        try {
            await new Promise((resolve, reject) => {
                this.init_async(
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (proxy, res) => {
                        try {
                            resolve(proxy.init_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            this._onNameOwnerChanged();
        } catch (e) {
            return Promise.reject(e);
        }
    }

    get available() {
        return this.devices.filter(device => (device.Connected && device.Paired));
    }

    get devices() {
        return Array.from(this._devices.values());
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        try {
            // Don't emit signals until the name is properly owned
            if (!this.g_name_owner === null) return;

            parameters = parameters.deep_unpack();

            switch (true) {
                case (signal_name === 'InterfacesAdded'):
                    this._onInterfacesAdded(...parameters);
                    break;

                case (signal_name === 'InterfacesRemoved'):
                    this._onInterfacesRemoved(...parameters);
                    break;
            }
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceChanged(proxy, changed, invalidated) {
        changed = changed.deep_unpack();

        if (changed.hasOwnProperty('Connected') || changed.hasOwnProperty('Paired')) {
            this.emit('available-changed');
        }
    }

    _proxyGetter(name) {
        let variant = this.get_cached_property(name);
        return variant ? variant.deep_unpack() : null;
    }

    async _getProxy(object_path) {
        try {
            let proxy = new Gio.DBusProxy({
                g_connection: this.g_connection,
                g_name: this.g_name_owner,
                g_object_path: object_path,
                g_interface_name: DEVICE_NAME
            });

            // Initialize the device proxy
            await new Promise((resolve, reject) => {
                proxy.init_async(
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (proxy, res) => {
                        try {
                            resolve(proxy.init_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Setup properties
            for (let i = 0, len = DEVICE_INFO.properties.length; i < len; i++) {
                let property = DEVICE_INFO.properties[i];

                Object.defineProperty(proxy, property.name, {
                    get: this._proxyGetter.bind(proxy, property.name),
                    enumerable: true
                });
            }

            // GActions
            proxy.action_group = Gio.DBusActionGroup.get(
                proxy.g_connection,
                proxy.g_name,
                proxy.g_object_path
            );

            // GMenu
            proxy.menu_model = Gio.DBusMenuModel.get(
                proxy.g_connection,
                proxy.g_name,
                proxy.g_object_path
            );

            await this._Start(object_path);

            // GSettings
            proxy.settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(DEVICE_NAME, true),
                path: '/org/gnome/shell/extensions/gsconnect/device/' + proxy.Id + '/'
            });

            return proxy;
        } catch (e) {
            logError(e, object_path);
            return undefined;
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesAdded
     *
     * @param {string} object_path - Path interfaces have been removed from
     * @param {object[]} - ??
     */
    async _onInterfacesAdded(object_path, interfaces) {
        try {
            // An empty list means only the object has been added
            if (Object.values(interfaces).length === 0) return;

            // Skip existing proxies
            if (this._devices.has(object_path)) return;

            // Create a proxy
            let proxy = await this._getProxy(object_path);
            if (proxy === undefined) return;

            // Watch for connected/paired changes
            proxy.__deviceChangedId = proxy.connect(
                'g-properties-changed',
                this._onDeviceChanged.bind(this)
            );

            // Hold the proxy and emit ::device-added
            this._devices.set(object_path, proxy);
            this.emit('device-added', proxy);
        } catch (e) {
            logError(e, object_path);
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesRemoved
     *
     * @param {string} object_path - Path interfaces have been removed from
     * @param {string[]} - List of interface names removed
     */
    async _onInterfacesRemoved(object_path, interfaces) {
        try {
            // An empty interface list means the object is being removed
            if (interfaces.length === 0) return;

            // Get the proxy
            let proxy = this._devices.get(object_path);
            if (proxy === undefined) return;

            // Stop watching for connected/paired changes
            proxy.disconnect(proxy.__deviceChangedId);

            // Release the proxy and emit ::device-removed
            this._devices.delete(object_path);
            this.emit('device-removed', proxy);
        } catch (e) {
            logError(e, object_path);
        }
    }

    async _onNameOwnerChanged() {
        try {
            // If the service stopped, clear all devices before restarting
            if (this.g_name_owner === null) {
                this.clear();
                await this._GetManagedObjects();

            // Now that service is started, add each device manually
            } else {
                let objects = await this._GetManagedObjects();

                for (let [object_path, object] of Object.entries(objects)) {
                    await this._onInterfacesAdded(object_path, object);
                }
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.GetManagedObjects
     *
     * @return {object} - Dictionary of managed object paths and interface names
     */
    _GetManagedObjects() {
        return new Promise((resolve, reject) => {
            this.call(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        let variant = proxy.call_finish(res);
                        resolve(variant.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * org.gtk.Menus.Start
     *
     * We use this call to ensure that our connection is subscribed to GMenu
     * changes if the device is added after the service has started.
     *
     * @param {string} object_path
     */
    _Start(object_path) {
        return new Promise((resolve, reject) => {
            this.g_connection.call(
                this.g_name,
                object_path,
                'org.gtk.Menus',
                'Start',
                new GLib.Variant('(au)', [[0]]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        resolve(proxy.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    clear() {
        for (let device of this.devices) {
            device.disconnect(device.__deviceChangedId);
            this._devices.delete(device.g_object_path);
            this.emit('device-removed', device);
        }
    }

    destroy() {
        this.disconnect(this._nameOwnerChangedId);
        this.clear();
    }
});

