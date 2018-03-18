#!/usr/bin/env gjs

"use strict";

const ByteArray = imports.byteArray;
const System = imports.system;

imports.gi.versions.Gio = "2.0";
imports.gi.versions.GLib = "2.0";
imports.gi.versions.GObject = "2.0";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

window.gsconnect = { datadir: getPath() };
imports.searchPath.push(gsconnect.datadir);
const _bootstrap = imports._bootstrap;
const DBus = imports.modules.dbus;


function fromInt32 (byteArray) {
    var value = 0;

    for (var i = byteArray.length - 1; i >= 0; i--) {
        value = (value * 256) + byteArray[i];
    }

    return value;
};


function toInt32 (number) {
    var byteArray = [0, 0, 0, 0];

    for (var index_ = 0; index_ < byteArray.length; index_++) {
        var byte = number & 0xff;
        byteArray [index_] = byte;
        number = (number - byte) / 256 ;
    }

    return ByteArray.fromArray(byteArray);
};


function _proxyProperties(info, iface) {
    info.properties.map(property => {
        Object.defineProperty(iface, property.name.toUnderscoreCase(), {
            get: () => {
                return gsconnect.full_unpack(
                    iface.get_cached_property(property.name)
                );
            },
            configurable: true,
            enumerable: true
        });
    });
};


var DeviceInterface = gsconnect.dbusinfo.lookup_interface(
    "org.gnome.Shell.Extensions.GSConnect.Device"
);


var NativeMessagingHost = GObject.registerClass({
    GTypeName: "GSConnectNativeMessagingHost"
}, class NativeMessagingHost extends Gio.Application {

    _init() {
        super._init({
            application_id: "org.gnome.Shell.Extensions.GSConnect.NativeMessagingHost",
            flags: Gio.ApplicationFlags.NON_UNIQUE
        });
        gsconnect.installService();

        this._devices = {};
    }

    get devices() { return Object.values(this._devices); }

    vfunc_activate() {
        super.vfunc_activate();
        this.hold();
    }

    vfunc_startup() {
        super.vfunc_startup();

        // IO Channels
        this.stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: 0 })
        });

        this.stdout = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({ fd: 1 })
        });

        let source = this.stdin.base_stream.create_source(null);
        source.set_callback(this.receive.bind(this));
        source.attach(null);

        // ObjectManager
        Gio.DBusObjectManagerClient.new(
            Gio.DBus.session,
            Gio.DBusObjectManagerClientFlags.NONE,
            gsconnect.app_id,
            gsconnect.app_path,
            null, // get-proxy-type-func
            null,
            (obj, res) => {
                this.manager = Gio.DBusObjectManagerClient.new_finish(res);

                for (let object of this.manager.get_objects()) {
                    for (let iface of object.get_interfaces()) {
                        this._interfaceAdded(object, iface);
                    }
                }

                this.manager.connect("interface-added", this._interfaceAdded.bind(this));
                this.manager.connect("interface-removed", this._interfaceRemoved.bind(this));

                // Watch device property changes (connected, paired, plugins, etc)
                // FIXME: this could get crazy
                this.manager.connect("interface-proxy-properties-changed", () => {
                    this.sendDeviceList();
                });
            }
        );

        this.send({ type: "connected", data: true });
    }

    receive() {
        let message;

        try {
            let int32 = this.stdin.read_bytes(4, null).toArray();

            if (!int32.length) { this.quit(); }

            let length = fromInt32(int32);
            message = this.stdin.read_bytes(length, null).toArray().toString();

            message = JSON.parse(message);
        } catch (e) {
            debug(e);
            return;
        }

        debug("Received: " + JSON.stringify(message));

        if (message.type === "devices") {
            this.sendDeviceList();
        } else if (message.type === "share") {
            let actionName;
            let device = this._devices[message.data.device];

            if (device) {
                if (message.data.action === "share") {
                    actionName = "shareUrl";
                } else if (message.data.action === "telephony") {
                    actionName = ""; // FIXME
                }

                device.actions.activate_action(
                    actionName,
                    gsconnect.full_pack([message.data.url])
                );
            }
        }

        return true;
    }

    send(message) {
        try {
            let data = JSON.stringify(message);
            debug("WebExtension: send: " + data);

            let length = toInt32(data.length);
            this.stdout.write(length, null);
            this.stdout.put_string(data, null);
        } catch (e) {
            debug(e);
        }
    }

    sendDeviceList() {
        if (!this.manager || this.manager.name_owner === null) {
            // Inform the WebExtension we're disconnected from the service
            this.send({ type: "connected", data: false });
            return;
        }

        let devices = [];

        for (let device of this.devices) {
            let share = device.actions.get_action_enabled("shareUrl");
            // FIXME: need new telephony action for this
            let telephony = device.actions.get_action_enabled("newSms");

            if (device.connected && device.paired && (share || telephony)) {
                devices.push({
                    id: device.id,
                    name: device.name,
                    type: device.type,
                    share: share,
                    telephony: telephony
                });
            }
        }

        this.send({ type: "devices", data: devices });
    }

    _interfaceAdded(object, iface) {
        if (iface.g_interface_name === "org.gnome.Shell.Extensions.GSConnect.Device") {
            _proxyProperties(DeviceInterface, iface);

            iface.actions = Gio.DBusActionGroup.get(
                iface.g_connection,
                iface.g_name,
                iface.g_object_path
            );

            this._devices[iface.id] = iface;
        }
    }

    _interfaceRemoved(object, iface) {
        if (iface.g_interface_name === "org.gnome.Shell.Extensions.GSConnect.Device") {
            delete this._devices[iface.id];
        }
    }
});

(new NativeMessagingHost()).run([System.programInvocationName]);

