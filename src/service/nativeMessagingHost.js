#!/usr/bin/env gjs

'use strict';

imports.gi.versions.Gio = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const System = imports.system;

// Find the root datadir of the extension
function get_datadir() {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

window.gsconnect = {extdatadir: get_datadir()};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;
const DBus = imports.service.components.dbus;


const DeviceInterface = gsconnect.dbusinfo.lookup_interface(
    'org.gnome.Shell.Extensions.GSConnect.Device'
);


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

        // ObjectManager
        Gio.DBusObjectManagerClient.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
            gsconnect.app_id,
            gsconnect.app_path,
            null,
            null,
            this._init_async.bind(this)
        );
    }

    _init_async(obj, res) {
        try {
            this.manager = Gio.DBusObjectManagerClient.new_for_bus_finish(res);

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
                'interface-removed',
                this._onInterfaceRemoved.bind(this)
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
            logError(e);
            this.quit();
        }
    }

    receive() {
        let message;

        try {
            let length = this.stdin.read_int32(null);
            message = this.stdin.read_bytes(length, null).toArray();

            if (message instanceof Uint8Array) {
                message = imports.byteArray.toString(message);
            }

            message = JSON.parse(message);
        } catch (e) {
            logError(e);
            this.quit();
        }

        debug(message);

        if (message.type === 'devices') {
            this.sendDeviceList();
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
    }

    send(message) {
        debug(message);

        try {
            let data = JSON.stringify(message);
            this.stdout.put_int32(data.length, null);
            this.stdout.put_string(data, null);
        } catch (e) {
            logError(e);
            this.quit();
        }
    }

    sendDeviceList() {
        // Inform the WebExtension we're disconnected from the service
        if (this.manager && this.manager.name_owner === null) {
            this.send({type: 'connected', data: false});
            return;
        }

        let devices = [];

        for (let device of this.devices) {
            let share = device.actions.get_action_enabled('shareUri');
            let telephony = device.actions.get_action_enabled('shareSms');

            if (device.Connected && device.Paired && (share || telephony)) {
                devices.push({
                    id: device.Id,
                    name: device.Name,
                    type: device.Type,
                    share: share,
                    telephony: telephony
                });
            }
        }

        this.send({type: 'devices', data: devices});
    }

    _onInterfaceAdded(manager, object, iface) {
        if (iface.g_interface_name === 'org.gnome.Shell.Extensions.GSConnect.Device') {
            DBus.proxyProperties(iface, DeviceInterface);

            iface.actions = Gio.DBusActionGroup.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );

            this._devices[iface.Id] = iface;
            this.sendDeviceList();
        }
    }

    _onInterfaceRemoved(manager, object, iface) {
        if (iface.g_interface_name === 'org.gnome.Shell.Extensions.GSConnect.Device') {
            delete this._devices[iface.Id];
            this.sendDeviceList();
        }
    }
});

(new NativeMessagingHost()).run([System.programInvocationName]);

