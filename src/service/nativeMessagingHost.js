#!/usr/bin/env gjs

'use strict';

imports.gi.versions.Gio = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const System = imports.system;


const NativeMessagingHost = GObject.registerClass({
    GTypeName: 'GSConnectNativeMessagingHost',
}, class NativeMessagingHost extends Gio.Application {

    _init() {
        super._init({
            application_id: 'org.gnome.Shell.Extensions.GSConnect.NativeMessagingHost',
            flags: Gio.ApplicationFlags.NON_UNIQUE,
        });
    }

    get devices() {
        if (this._devices === undefined)
            this._devices = {};

        return this._devices;
    }

    vfunc_activate() {
        super.vfunc_activate();
    }

    vfunc_startup() {
        super.vfunc_startup();
        this.hold();

        // IO Channels
        this._stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({fd: 0}),
            byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN,
        });

        this._stdout = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({fd: 1}),
            byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN,
        });

        let source = this._stdin.base_stream.create_source(null);
        source.set_callback(this.receive.bind(this));
        source.attach(null);

        // Device Manager
        try {
            this._manager = Gio.DBusObjectManagerClient.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
                'org.gnome.Shell.Extensions.GSConnect',
                '/org/gnome/Shell/Extensions/GSConnect',
                null,
                null
            );
        } catch (e) {
            logError(e);
            this.quit();
        }

        // Add currently managed devices
        for (let object of this._manager.get_objects()) {
            for (let iface of object.get_interfaces())
                this._onInterfaceAdded(this._manager, object, iface);
        }

        // Watch for new and removed devices
        this._manager.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );
        this._manager.connect(
            'object-removed',
            this._onObjectRemoved.bind(this)
        );

        // Watch for device property changes
        this._manager.connect(
            'interface-proxy-properties-changed',
            this.sendDeviceList.bind(this)
        );

        // Watch for service restarts
        this._manager.connect(
            'notify::name-owner',
            this.sendDeviceList.bind(this)
        );

        this.send({
            type: 'connected',
            data: (this._manager.name_owner !== null),
        });
    }

    receive() {
        try {
            // Read the message
            let length = this._stdin.read_int32(null);
            let bytes = this._stdin.read_bytes(length, null).toArray();
            let message = JSON.parse(imports.byteArray.toString(bytes));

            // A request for a list of devices
            if (message.type === 'devices') {
                this.sendDeviceList();

            // A request to invoke an action
            } else if (message.type === 'share') {
                let actionName;
                let device = this.devices[message.data.device];

                if (device) {
                    if (message.data.action === 'share')
                        actionName = 'shareUri';
                    else if (message.data.action === 'telephony')
                        actionName = 'shareSms';

                    device.actions.activate_action(
                        actionName,
                        new GLib.Variant('s', message.data.url)
                    );
                }
            }

            return GLib.SOURCE_CONTINUE;
        } catch (e) {
            this.quit();
        }
    }

    send(message) {
        try {
            let data = JSON.stringify(message);
            this._stdout.put_int32(data.length, null);
            this._stdout.put_string(data, null);
        } catch (e) {
            this.quit();
        }
    }

    sendDeviceList() {
        // Inform the WebExtension we're disconnected from the service
        if (this._manager && this._manager.name_owner === null)
            return this.send({type: 'connected', data: false});

        // Collect all the devices with supported actions
        let available = [];

        for (let device of Object.values(this.devices)) {
            let share = device.actions.get_action_enabled('shareUri');
            let telephony = device.actions.get_action_enabled('shareSms');

            if (share || telephony) {
                available.push({
                    id: device.g_object_path,
                    name: device.name,
                    type: device.type,
                    share: share,
                    telephony: telephony,
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
                enumerable: true,
            },
            // TODO: phase this out for icon-name
            'type': {
                get: this._proxyGetter.bind(iface, 'Type'),
                enumerable: true,
            },
        });

        iface.actions = Gio.DBusActionGroup.get(
            iface.g_connection,
            iface.g_name,
            iface.g_object_path
        );

        this.devices[iface.g_object_path] = iface;
        this.sendDeviceList();
    }

    _onObjectRemoved(manager, object) {
        delete this.devices[object.g_object_path];
        this.sendDeviceList();
    }
});

// NOTE: must not pass ARGV
(new NativeMessagingHost()).run([System.programInvocationName]);

