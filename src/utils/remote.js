'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const SERVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect';
const SERVICE_PATH = '/org/gnome/Shell/Extensions/GSConnect';
const DEVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect.Device';
const DEVICE_PATH = '/org/gnome/Shell/Extensions/GSConnect/Device';


const _PROPERTIES = {
    'Connected': 'connected',
    'EncryptionInfo': 'encryption-info',
    'IconName': 'icon-name',
    'Id': 'id',
    'Name': 'name',
    'Paired': 'paired',
    'Type': 'type',
};


function _proxyInit(proxy, cancellable = null) {
    if (proxy.__initialized !== undefined)
        return Promise.resolve();

    return new Promise((resolve, reject) => {
        proxy.init_async(
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (proxy, res) => {
                try {
                    proxy.init_finish(res);
                    proxy.__initialized = true;
                    resolve();
                } catch (e) {
                    Gio.DBusError.strip_remote_error(e);
                    reject(e);
                }
            }
        );
    });
}


/**
 * A simple proxy wrapper for devices exported over DBus.
 */
var Device = GObject.registerClass({
    GTypeName: 'GSConnectRemoteDevice',
    Implements: [Gio.DBusInterface],
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'Connected',
            'Whether the device is connected',
            GObject.ParamFlags.READABLE,
            null
        ),
        'encryption-info': GObject.ParamSpec.string(
            'encryption-info',
            'Encryption Info',
            'A formatted string with the local and remote fingerprints',
            GObject.ParamFlags.READABLE,
            null
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'Icon Name',
            'Icon name representing the device',
            GObject.ParamFlags.READABLE,
            null
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'deviceId',
            'The device hostname or other unique id',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'deviceName',
            'The device name',
            GObject.ParamFlags.READABLE,
            null
        ),
        'paired': GObject.ParamSpec.boolean(
            'paired',
            'Paired',
            'Whether the device is paired',
            GObject.ParamFlags.READABLE,
            null
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'deviceType',
            'The device type',
            GObject.ParamFlags.READABLE,
            null
        ),
    },
}, class Device extends Gio.DBusProxy {

    _init(service, object_path) {
        this._service = service;

        super._init({
            g_connection: service.g_connection,
            g_name: SERVICE_NAME,
            g_object_path: object_path,
            g_interface_name: DEVICE_NAME,
        });
    }

    vfunc_g_properties_changed(changed, invalidated) {
        try {
            for (const name in changed.deepUnpack())
                this.notify(_PROPERTIES[name]);
        } catch (e) {
            logError(e);
        }
    }

    _get(name, fallback = null) {
        try {
            return this.get_cached_property(name).unpack();
        } catch (e) {
            return fallback;
        }
    }

    get connected() {
        return this._get('Connected', false);
    }

    get encryption_info() {
        return this._get('EncryptionInfo', '');
    }

    get icon_name() {
        return this._get('IconName', 'computer');
    }

    get id() {
        return this._get('Id', '0');
    }

    get name() {
        return this._get('Name', 'Unknown');
    }

    get paired() {
        return this._get('Paired', false);
    }

    get service() {
        return this._service;
    }

    get type() {
        return this._get('Type', 'desktop');
    }

    async start() {
        try {
            await _proxyInit(this);

            // For GActions & GMenu we pass the service's name owner to avoid
            // any mixup with instances.
            this.action_group = Gio.DBusActionGroup.get(
                this.g_connection,
                this.service.g_name_owner,
                this.g_object_path
            );

            this.menu = Gio.DBusMenuModel.get(
                this.g_connection,
                this.service.g_name_owner,
                this.g_object_path
            );

            // Poke the GMenu to ensure it's ready for us
            await new Promise((resolve, reject) => {
                this.g_connection.call(
                    SERVICE_NAME,
                    this.g_object_path,
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
                            Gio.DBusError.strip_remote_error(e);
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    destroy() {
        GObject.signal_handlers_destroy(this);
    }
});


/**
 * A simple proxy wrapper for the GSConnect service.
 */
var Service = GObject.registerClass({
    GTypeName: 'GSConnectRemoteService',
    Implements: [Gio.DBusInterface],
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active',
            'Active',
            'Whether the service is active',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
    Signals: {
        'device-added': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [Device.$gtype],
        },
        'device-removed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [Device.$gtype],
        },
    },
}, class Service extends Gio.DBusProxy {

    _init() {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: SERVICE_NAME,
            g_object_path: SERVICE_PATH,
            g_interface_name: 'org.freedesktop.DBus.ObjectManager',
            g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
        });

        this._active = false;
        this._devices = new Map();
        this._starting = false;

        // Watch the service
        this._nameOwnerChangedId = this.connect(
            'notify::g-name-owner',
            this._onNameOwnerChanged.bind(this)
        );
    }

    get active() {
        return this._active;
    }

    get devices() {
        return Array.from(this._devices.values());
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        try {
            // Don't emit signals until the ObjectManager has started
            if (!this.active)
                return;

            parameters = parameters.deepUnpack();

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

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesAdded
     *
     * @param {string} object_path - Path interfaces have been added to
     * @param {Object} interfaces - A dictionary of interface objects
     */
    async _onInterfacesAdded(object_path, interfaces) {
        try {
            // An empty list means only the object has been added
            if (Object.values(interfaces).length === 0)
                return;

            // Skip existing proxies
            if (this._devices.has(object_path))
                return;

            // Create a proxy
            const device = new Device(this, object_path);
            await device.start();

            // Hold the proxy and emit ::device-added
            this._devices.set(object_path, device);
            this.emit('device-added', device);
        } catch (e) {
            logError(e, object_path);
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesRemoved
     *
     * @param {string} object_path - Path interfaces have been removed from
     * @param {string[]} interfaces - List of interface names removed
     */
    _onInterfacesRemoved(object_path, interfaces) {
        try {
            // An empty interface list means the object is being removed
            if (interfaces.length === 0)
                return;

            // Get the proxy
            const device = this._devices.get(object_path);

            if (device === undefined)
                return;

            // Release the proxy and emit ::device-removed
            this._devices.delete(object_path);
            this.emit('device-removed', device);

            // Destroy the device and force disposal
            device.destroy();
        } catch (e) {
            logError(e, object_path);
        }
    }

    async _addDevices() {
        const objects = await new Promise((resolve, reject) => {
            this.call(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        const variant = proxy.call_finish(res);
                        resolve(variant.deepUnpack()[0]);
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });

        for (const [object_path, object] of Object.entries(objects))
            await this._onInterfacesAdded(object_path, object);
    }

    _clearDevices() {
        for (const [object_path, device] of this._devices) {
            this._devices.delete(object_path);
            this.emit('device-removed', device);
            device.destroy();
        }
    }

    async _onNameOwnerChanged() {
        try {
            // If the service stopped, remove each device and mark it inactive
            if (this.g_name_owner === null) {
                this._clearDevices();

                this._active = false;
                this.notify('active');

            // If the service started, mark it active and add each device
            } else {
                this._active = true;
                this.notify('active');

                await this._addDevices();
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Reload all devices without affecting the remote service. This amounts to
     * removing and adding each device while emitting the appropriate signals.
     */
    async reload() {
        try {
            if (this._starting === false) {
                this._starting = true;

                this._clearDevices();
                await _proxyInit(this);
                await this._onNameOwnerChanged();

                this._starting = false;
            }
        } catch (e) {
            this._starting = false;
            throw e;
        }
    }

    /**
     * Start the service
     */
    async start() {
        try {
            if (this._starting === false && this.active === false) {
                this._starting = true;

                await _proxyInit(this);
                await this._onNameOwnerChanged();

                // Activate the service if it's not already running
                if (!this.active) {
                    await new Promise((resolve, reject) => {
                        this.g_connection.call(
                            SERVICE_NAME,
                            SERVICE_PATH,
                            'org.freedesktop.Application',
                            'Activate',
                            GLib.Variant.new('(a{sv})', [{}]),
                            null,
                            Gio.DBusCallFlags.NONE,
                            -1,
                            null,
                            (proxy, res) => {
                                try {
                                    resolve(proxy.call_finish(res));
                                } catch (e) {
                                    Gio.DBusError.strip_remote_error(e);
                                    reject(e);
                                }
                            }
                        );
                    });
                }

                this._starting = false;
            }
        } catch (e) {
            this._starting = false;
            throw e;
        }
    }

    /**
     * Stop the service
     */
    stop() {
        if (this.active)
            this.activate_action('quit');
    }

    activate_action(name, parameter = null) {
        try {
            const paramArray = [];

            if (parameter instanceof GLib.Variant)
                paramArray[0] = parameter;

            const connection = this.g_connection || Gio.DBus.session;

            connection.call(
                SERVICE_NAME,
                SERVICE_PATH,
                'org.freedesktop.Application',
                'ActivateAction',
                GLib.Variant.new('(sava{sv})', [name, paramArray, {}]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        if (this._nameOwnerChangedId > 0) {
            this.disconnect(this._nameOwnerChangedId);
            this._nameOwnerChangedId = 0;

            this._clearDevices();
            this._active = false;

            GObject.signal_handlers_destroy(this);
        }
    }
});

