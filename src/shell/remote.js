'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const DEVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect.Device';


function toHyphenCase(string) {
    if (toHyphenCase.__cache === undefined) {
        toHyphenCase.__cache = {};
    }

    if (!toHyphenCase.__cache[string]) {
        toHyphenCase.__cache[string] = string.replace(/(?:[A-Z])/g, (c, i) => {
            return (i > 0) ? '-' + c.toLowerCase() : c.toLowerCase();
        }).replace(/[\s_]+/g, '');
    }

    return toHyphenCase.__cache[string];
}


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
        'display-type': GObject.ParamSpec.string(
            'display-type',
            'Display Type',
            'A user-visible type string',
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
        )
    }
}, class Device extends Gio.DBusProxy {

    _init(service, object_path) {
        this._service = service;

        super._init({
            g_connection: service.g_connection,
            g_name: service.g_name,
            g_object_path: object_path,
            g_interface_name: `${service.g_name}.Device`
        });
    }

    async start() {
        try {
            // Initialize the proxy
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

            // GActions
            this.action_group = Gio.DBusActionGroup.get(
                this.g_connection,
                this._service.g_name_owner,
                this.g_object_path
            );

            // GMenu
            this.menu_model = Gio.DBusMenuModel.get(
                this.g_connection,
                this._service.g_name_owner,
                this.g_object_path
            );

            // Subscribe to the GMenu
            await new Promise((resolve, reject) => {
                this.g_connection.call(
                    this.g_name,
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
                            reject(e);
                        }
                    }
                );
            });

            return true;
        } catch (e) {
            logError(e);
            return false;
        }
    }

    // Proxy GObject::notify signals
    vfunc_g_properties_changed(changed, invalidated) {
        for (let name in changed.deep_unpack()) {
            this.notify(toHyphenCase(name));
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

    get display_type() {
        return this._get('DisplayType', '');
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

    get settings() {
        if (this._settings === undefined) {
            this._settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(
                    this.g_interface_name,
                    true
                ),
                path: '/org/gnome/shell/extensions/gsconnect/device/' + this.id + '/'
            });
        }

        return this._settings;
    }

    get service() {
        return this._service;
    }

    get type() {
        return this._get('Type', 'desktop');
    }

    get_incoming_supported(type) {
        let incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    get_outgoing_supported(type) {
        let outgoing = this.settings.get_strv('outgoing-capabilities');
        return outgoing.includes(`kdeconnect.${type}`);
    }

    destroy() {
        this.action_group.run_dispose();
        this.menu_model.run_dispose();

        if (this.__propertiesChangedId)
            this.disconnect(this.__propertiesChangedId);

        if (this._settings)
            this._settings.run_dispose();
    }
});


var Service = GObject.registerClass({
    GTypeName: 'GSConnectRemoteService',
    Implements: [Gio.DBusInterface],
    Properties: {
        'devices': GObject.param_spec_variant(
            'devices',
            'Devices',
            'A list of known devices',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    },
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

    get available() {
        return this.devices.filter(device => (device.connected && device.paired));
    }

    get devices() {
        return Array.from(this._devices.values());
    }

    get settings() {
        if (this._settings === undefined) {
            this._settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(this.g_name, true),
                path: '/org/gnome/shell/extensions/gsconnect/'
            });
        }

        return this._settings;
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

        if (changed.hasOwnProperty('Connected') ||
            changed.hasOwnProperty('Paired')) {
            this.emit('available-changed');
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
            
            // This can still happen here
            if (this.g_name_owner === null) return;

            // Skip existing proxies
            if (this._devices.has(object_path)) return;

            // Create a proxy
            let device = new Device(this, object_path);
            await device.start();

            // Watch for connected/paired changes
            device.__deviceChangedId = device.connect(
                'g-properties-changed',
                this._onDeviceChanged.bind(this)
            );

            // Hold the proxy and emit ::device-added
            this._devices.set(object_path, device);
            this.emit('device-added', device);
            this.notify('devices');
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
            let device = this._devices.get(object_path);
            if (device === undefined) return;

            // Stop watching for connected/paired changes
            device.disconnect(device.__deviceChangedId);

            // Release the proxy and emit ::device-removed
            this._devices.delete(object_path);
            this.emit('device-removed', device);
            this.notify('devices');
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

    async start() {
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
    }

    broadcast() {
        if (!this.g_connection) return;

        let action_name = 'broadcast';

        this.g_connection.call(
            this.g_name,
            this.g_object_path,
            'org.gtk.Actions',
            'Activate',
            GLib.Variant.new('(sava{sv})', [action_name, [], {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );
    }

    preferences() {
        gsconnect.preferences();
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

