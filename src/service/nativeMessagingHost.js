#!/usr/bin/env gjs

"use strict";

const ByteArray = imports.byteArray;
const Lang = imports.lang;
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


var NativeMessagingHost = new Lang.Class({
    Name: "GSConnectNativeMessagingHost",
    Extends: Gio.Application,

    _init: function () {
        this.parent({
            application_id: "org.gnome.Shell.Extensions.GSConnect.NativeMessagingHost",
            flags: Gio.ApplicationFlags.NON_UNIQUE
        });
        gsconnect.installService();
    },

    vfunc_activate: function() {
        this.parent();
        this.hold();
    },

    vfunc_startup: function() {
        this.parent();

        this.stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: 0 })
        });

        let source = this.stdin.base_stream.create_source(null);
        source.set_callback(Lang.bind(this, this.receive));
        source.attach(null);

        this.stdout = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({ fd: 1 })
        });

        Gio.DBusObjectManagerClient.new(
            Gio.DBus.session,
            Gio.DBusObjectManagerClientFlags.NONE,
            gsconnect.app_id,
            gsconnect.app_path,
            null, // get-proxy-type-func
            null,
            (obj, res) => {
                this.manager = Gio.DBusObjectManagerClient.new_finish(res);

                this.manager.connect("notify::name-owner", () => this.sendDeviceList());
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
    },

    receive: function () {
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
            for (let device of this.manager.get_devices()) {
                if (device.id === message.data.device) {
                    device[message.data.action].shareUrl(message.data.url);
                }
            }
        }

        return true;
    },

    send: function (message) {
        try {
            let data = JSON.stringify(message);
            debug("WebExtension: send: " + data);

            let length = toInt32(data.length);
            this.stdout.write(length, null);
            this.stdout.put_string(data, null);
        } catch (e) {
            debug(e);
        }
    },

    sendDeviceList: function () {
        if (this.manager.name_owner === null) {
            // Inform the WebExtension we're disconnected from the service
            this.send({ type: "connected", data: false });
            return;
        }

        let devices = [];

        // FIXME: GActions
        for (let device of this.manager.get_devices()) {
            let share = (device.plugins.indexOf("share") > -1);
            let telephony = (device.plugins.indexOf("telephony") > -1);

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
    },

    _interfaceAdded: function (object, iface) {
    },

    _interfaceRemoved: function (object, iface) {
    }
});

(new NativeMessagingHost()).run([System.programInvocationName]);

