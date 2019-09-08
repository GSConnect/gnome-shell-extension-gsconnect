'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


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
            g_name: 'org.gnome.Shell.Extensions.GSConnect',
            g_object_path: object_path,
            g_interface_name: 'org.gnome.Shell.Extensions.GSConnect.Device'
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
                            Gio.DBusError.strip_remote_error(e);
                            reject(e);
                        }
                    }
                );
            });

            // GActions
            this.action_group = Gio.DBusActionGroup.get(
                this.g_connection,
                this.service.g_name_owner,
                this.g_object_path
            );

            // GMenu
            this.menu = Gio.DBusMenuModel.get(
                this.g_connection,
                this.service.g_name_owner,
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

    // Proxy GObject::notify signals
    vfunc_g_properties_changed(changed, invalidated) {
        try {
            for (let name in changed.deep_unpack()) {
                this.notify(toHyphenCase(name));
            }
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
        if (this.__disposed === undefined) {
            this.__disposed = true;

            if (this._settings) {
                this._settings.run_dispose();
                this._settings = null;
            }

            this.run_dispose();
        }
    }
});


var Service = GObject.registerClass({
    GTypeName: 'GSConnectRemoteService',
    Implements: [Gio.DBusInterface],
    Signals: {
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

    get devices() {
        return Array.from(this._devices.values());
    }

    get settings() {
        if (this._settings === undefined) {
            this._settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(
                    'org.gnome.Shell.Extensions.GSConnect',
                    true
                ),
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
     * @param {string[]} - List of interface names removed
     */
    _onInterfacesRemoved(object_path, interfaces) {
        try {
            // An empty interface list means the object is being removed
            if (interfaces.length === 0) return;

            // Get the proxy
            let device = this._devices.get(object_path);
            if (device === undefined) return;

            // Release the proxy and emit ::device-removed
            this._devices.delete(object_path);
            this.emit('device-removed', device);

            device.destroy();
        } catch (e) {
            logError(e, object_path);
        }
    }

    async _onNameOwnerChanged() {
        try {
            // If the service stopped, clear all devices before restarting
            if (this.g_name_owner === null) {
                this._clearDevices();
                await this._GetManagedObjects();

            // Now that service is started, add each device manually
            } else {
                let objects = await this._GetManagedObjects();

                for (let [object_path, object] of Object.entries(objects)) {
                    await this._onInterfacesAdded(object_path, object);
                }
            }
        } catch (e) {
            Gio.DBusError.strip_remote_error(e);
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

    _clearDevices() {
        for (let [object_path, device] of this._devices) {
            this._devices.delete(object_path);
            this.emit('device-removed', device);
            device.destroy();
        }
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
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });

        this._onNameOwnerChanged();
    }

    activate_action(name, parameter) {
        if (!this.g_connection) return;

        let paramArray = [];

        if (parameter instanceof GLib.Variant) {
            paramArray[0] = parameter;
        }

        this.g_connection.call(
            'org.gnome.Shell.Extensions.GSConnect',
            '/org/gnome/Shell/Extensions/GSConnect',
            'org.gtk.Actions',
            'Activate',
            GLib.Variant.new('(sava{sv})', [name, paramArray, {}]),
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

    destroy() {
        if (this.__disposed === undefined) {
            this.__disposed = true;

            this.disconnect(this._nameOwnerChangedId);
            this._clearDevices();
            this.run_dispose();
        }
    }
});

