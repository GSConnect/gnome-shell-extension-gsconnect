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

window.ext = { datadir: getPath() };

imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Client = imports.client;


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

    },

    vfunc_activate: function() {
        this.parent();
        this.hold();
    },

    vfunc_startup: function() {
        this.parent();

        this.daemon = new Client.Daemon();

        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            Client.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );

        this.stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: 0 })
        });

        let source = this.stdin.base_stream.create_source(null);
        source.set_callback(Lang.bind(this, this.receive));
        source.attach(null);

        this.stdout = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({ fd: 1 })
        });
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
            log("Error receiving message: " + e.message);
            return;
        }

        debug("WebExtension: receive: " + JSON.stringify(message));

        if (message.type === "devices") {
            this.sendDeviceList();
        } else if (message.type === "share") {
            for (let device of this.daemon.devices.values()) {
                if (device.id === message.data.device) {
                    device[message.data.action].shareUri(message.data.url);
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
            log("Error sending message: " + e.message);
        }
    },

    sendDeviceList: function () {
        let devices = [];

        for (let device of this.daemon.devices.values()) {
            if (device.connected && device.paired && (device.share || device.telephony)) {
                devices.push({
                    id: device.id,
                    name: device.name,
                    type: device.type,
                    share: (device.share),
                    telephony: (device.telephony)
                });
            }
        }

        this.send({ type: "devices", data: devices });
    },

    _serviceAppeared: function (conn, name, name_owner) {
        debug("WebExtension._serviceAppeared()");

        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }

        // Watch device property changes (connected, paired, plugins, etc)
        for (let device of this.daemon.devices.values()) {
            device.connect("notify", () => this.sendDeviceList());
        }

        // Watch for new and removed devices
        this.daemon.connect("device::added", (daemon, dbusPath) => {
            let device = this.daemon.devices.get(dbusPath);
            device.connect("notify", () => this.sendDeviceList());
            this.sendDeviceList();
        });

        this.daemon.connect("device::removed", () => this.sendDeviceList());

        this.send({ type: "connected", data: true });
    },

    _serviceVanished: function (conn, name) {
        debug("WebExtension._serviceVanished()");

        this.send({ type: "connected", data: false });

        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }

        this.daemon = new Client.Daemon();
    }
});

(new NativeMessagingHost()).run([System.programInvocationName]);

