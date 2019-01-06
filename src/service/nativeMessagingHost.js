#!/usr/bin/env gjs

'use strict';

imports.gi.versions.Gio = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const System = imports.system;


var NativeMessagingHost = GObject.registerClass({
    GTypeName: 'GSConnectNativeMessagingHost'
}, class NativeMessagingHost extends Gio.Application {

    _init() {
        super._init({
            application_id: 'org.gnome.Shell.Extensions.GSConnect.NativeMessagingHost',
            flags: Gio.ApplicationFlags.NON_UNIQUE
        });
    }

    get devices() {
        if (this._devices === undefined) {
            this._devices = {};
        }

        return Object.values(this._devices);
    }

    vfunc_activate() {
        super.vfunc_activate();
    }

    vfunc_startup() {
        super.vfunc_startup();
        this.hold();

        // IO Channels
        this.stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({fd: 0}),
            byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
        });

        this.stdout = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({fd: 1}),
            byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
        });

        let source = this.stdin.base_stream.create_source(null);
        source.set_callback(this.receive.bind(this));
        source.attach(null);

        this._init_async();
    }

    async _init_async(obj, res) {
        try {
            this.manager = await new Promise((resolve, reject) => {
                Gio.DBusObjectManagerClient.new_for_bus(
                    Gio.BusType.SESSION,
                    Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
                    'org.gnome.Shell.Extensions.GSConnect',
                    '/org/gnome/Shell/Extensions/GSConnect',
                    null,
                    null,
                    (manager, res) => {
                        try {
                            resolve(Gio.DBusObjectManagerClient.new_for_bus_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Add currently managed devices
            for (let object of this.manager.get_objects()) {
                for (let iface of object.get_interfaces()) {
                    this._onInterfaceAdded(this.manager, object, iface);
                }
            }

            // Watch for new and removed devices
            this.manager.connect(
                'interface-added',
                this._onInterfaceAdded.bind(this)
            );
            this.manager.connect(
                'object-removed',
                this._onObjectRemoved.bind(this)
            );

            // Watch for device property changes
            this.manager.connect(
                'interface-proxy-properties-changed',
                this.sendDeviceList.bind(this)
            );

            // Watch for service restarts
            this.manager.connect(
                'notify::name-owner',
                this.sendDeviceList.bind(this)
            );

            this.send({type: 'connected', data: true});
        } catch (e) {
            this.quit();
        }
    }

    receive() {
        try {
            // Read the message
            let length = this.stdin.read_int32(null);
            let message = this.stdin.read_bytes(length, null).toArray();

            if (message instanceof Uint8Array) {
                message = imports.byteArray.toString(message);
            }

            message = JSON.parse(message);

            // A request for a list of devices
            if (message.type === 'devices') {
                this.sendDeviceList();

            // A request to invoke an action
            } else if (message.type === 'share') {
                let actionName;
                let device = this._devices[message.data.device];

                if (device) {
                    if (message.data.action === 'share') {
                        actionName = 'shareUri';
                    } else if (message.data.action === 'telephony') {
                        actionName = 'shareSms';
                    }

                    device.actions.activate_action(
                        actionName,
                        new GLib.Variant('s', message.data.url)
                    );
                }
            }

            return true;
        } catch (e) {
            this.quit();
        }
    }

    send(message) {
        try {
            let data = JSON.stringify(message);
            this.stdout.put_int32(data.length, null);
            this.stdout.put_string(data, null);
        } catch (e) {
            this.quit();
        }
    }

    sendDeviceList() {
        // Inform the WebExtension we're disconnected from the service
        if (this.manager && this.manager.name_owner === null) {
            this.send({type: 'connected', data: false});
            return;
        }

        let available = [];

        for (let device of this.devices) {
            let share = device.actions.get_action_enabled('shareUri');
            let telephony = device.actions.get_action_enabled('shareSms');

            if (share || telephony) {
                available.push({
                    id: device.g_object_path,
                    name: device.name,
                    type: device.type,
                    share: share,
                    telephony: telephony
                });
            }
        }

        this.send({type: 'devices', data: available});
    }

    _proxyGetter(name) {
        try {
            return this.get_cached_property(name).unpack();
        } catch (e) {
            return null;
        }
    }

    _onInterfaceAdded(manager, object, iface) {
        Object.defineProperties(iface, {
            'name': {
                get: this._proxyGetter.bind(iface, 'Name'),
                enumerable: true
            },
            // TODO: phase this out for icon-name
            'type': {
                get: this._proxyGetter.bind(iface, 'Type'),
                enumerable: true
            }
        });

        iface.actions = Gio.DBusActionGroup.get(
            iface.g_connection,
            iface.g_name,
            iface.g_object_path
        );

        this._devices[iface.g_object_path] = iface;
        this.sendDeviceList();
    }

    _onObjectRemoved(manager, object) {
        delete this._devices[object.g_object_path];
        this.sendDeviceList();
    }
});

// NOTE: must not pass ARGV
(new NativeMessagingHost()).run([System.programInvocationName]);

