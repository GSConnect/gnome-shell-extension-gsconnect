'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

function log(message) {
    GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
        'MESSAGE': message,
        'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect.BluetoothHandoff'
    });
}

/**
 * A class representing the local bluetooth devices.
 */
var LocalBluetoothDevices = GObject.registerClass({
    GTypeName: 'GSConnectLocalBluetoothDevices',
    Signals: {
        'changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class LocalBluetoothDevices extends GObject.Object {

    _init() {
        try {
            super._init();

            this._cancellable = new Gio.Cancellable();
            this._proxy = null;
            this._propertiesChangedId = 0;
            this._localDevices = {};
            this._localDevicesJson = "{}";

            this._loadBluez();
        } catch (e) {
            log("bluez ERR: " + e.message);
        }
    }

    async _loadBluez() {
        try {
            this._proxy = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SYSTEM,
                g_name: 'org.bluez',
                g_object_path: '/',
                g_interface_name: 'org.freedesktop.DBus.ObjectManager',
            });

            await new Promise((resolve, reject) => {
                this._proxy.init_async(
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                    (proxy, res) => {
                        try {
                            resolve(proxy.init_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            this._fetchDevices();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._fetchDevices();

                if (!this._cancellable.is_cancelled()) {
                    return GLib.SOURCE_CONTINUE;
                } else {
                    return GLib.SOURCE_REMOVE;
                }
            });
        } catch (e) {
            log("ERR: " + e.message);
            this._proxy = null;
        }
    }

    async _fetchDevices() {
        try {
        let objects = await new Promise((resolve, reject) => {
            this._proxy.call(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                1000,
                this._cancellable,
                (proxy, res) => {
                    try {
                        const reply = proxy.call_finish(res);
                        resolve(reply.deepUnpack()[0]);
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });

        const newLocalDevices = await Promise.all(Object.keys(objects)
            .filter((rawObjectPath) => {
                const objectPath = rawObjectPath.split('/');
                return objectPath.length == 5 && objectPath[0] == '' && objectPath[1] == 'org' && objectPath[2] == 'bluez'
                    && objectPath[3].startsWith('hci') && objectPath[4].startsWith('dev_');
            }).map(async (objectPath) => {
                const objectProxy = new Gio.DBusProxy({
                    g_bus_type: Gio.BusType.SYSTEM,
                    g_name: 'org.bluez',
                    g_object_path: objectPath,
                    g_interface_name: 'org.bluez.Device1',
                });

                await new Promise((resolve, reject) => {
                    objectProxy.init_async(
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (proxy, res) => {
                            try {
                                proxy.init_finish(res);
                                resolve();
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                try {
                    let addr = objectProxy.get_cached_property('Address');
                    if (addr) addr = addr.recursiveUnpack();
                    let alias = objectProxy.get_cached_property('Alias');
                    if (alias) alias = alias.recursiveUnpack();
                    let name = objectProxy.get_cached_property('Name');
                    if (name) name = name.recursiveUnpack();
                    let adapter = objectProxy.get_cached_property('Adapter');
                    if (adapter) adapter = adapter.recursiveUnpack();
                    let icon = objectProxy.get_cached_property('Icon');
                    if (icon) icon = icon.recursiveUnpack();
                    let paired = objectProxy.get_cached_property('Paired');
                    if (paired) paired = paired.recursiveUnpack();
                    let connected = objectProxy.get_cached_property('Connected');
                    if (connected) connected = connected.recursiveUnpack();

                    return {
                        addr,
                        alias,
                        name,
                        adapter,
                        icon,
                        paired,
                        connected,
                    }
                } catch (e) {
                    log(" -> err - " + e);
                }
            }));

            const newLocalDevicesJson = JSON.stringify(newLocalDevices);
            if (newLocalDevicesJson != this._localDevicesJson) {
                this._localDevices = newLocalDevices;
                this._localDevicesJson = newLocalDevicesJson;
                this.emit('changed');
            }
        } catch (e) {
            log(" -> err - " + e);
        }
    }

    get local_devices() {
        return this._localDevices;
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();
    }
});


/**
 * The service class for this component
 */
var Component = LocalBluetoothDevices;

