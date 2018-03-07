"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Lock",
    incomingCapabilities: ["kdeconnect.lock", "kdeconnect.lock.request"],
    outgoingCapabilities: ["kdeconnect.lock", "kdeconnect.lock.request"],
    actions: {},
    events: {}
};


var ScreenSaverNode = Gio.DBusNodeInfo.new_for_xml(
'<node> \
  <interface name="org.gnome.ScreenSaver"> \
    <method name="Lock"/> \
    <method name="GetActive"> \
      <arg name="active" direction="out" type="b"/> \
    </method> \
    <method name="SetActive"> \
      <arg name="value" direction="in" type="b"/> \
    </method> \
    <method name="GetActiveTime"> \
      <arg name="value" direction="out" type="u"/> \
    </method> \
    <signal name="ActiveChanged"> \
      <arg name="new_value" type="b"/> \ \
    </signal> \
    <signal name="WakeUpScreen"/> \
  </interface> \
</node>');

var ScreenSaverIface = ScreenSaverNode.lookup_interface("org.gnome.ScreenSaver");
var ScreenSaverProxy = DBus.makeInterfaceProxy(ScreenSaverIface);


/**
 * Lock Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/lockdevice
 */
var Plugin = new Lang.Class({
    Name: "GSConnectLockPlugin",
    Extends: PluginsBase.Plugin,
    Properties: {
        "locked": GObject.ParamSpec.boolean(
            "locked",
            "deviceLocked",
            "Whether the device is locked",
            GObject.ParamFlags.READWRITE,
            false
        )
    },

    _init: function (device) {
        this.parent(device, "lock");

        this._locked = false;
//        this._request();

//        this._screensaver = new ScreenSaverProxy({
//            g_connection: Gio.DBus.session,
//            g_name: "org.gnome.ScreenSaver",
//            g_object_path: "/org/gnome/ScreenSaver"
//        });

//        this._screensaver.init_promise().then(result => {
//            this._activeChanged = this._screensaver.connect(
//                "active-changed",
//                (proxy, sender, active) => this._response(active)
//            );
//        }).catch(e => debug(e));
    },

    get locked () {
        return this._locked || false; // TODO
    },

    set locked (bool) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock.request",
            body: { setLocked: bool }
        });

        this.device.sendPacket(packet);
    },

    _request: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock.request",
            body: { requestLocked: true }
        });

        this.device.sendPacket(packet);
    },

    _response: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock",
            body: { isLocked: this._screensaver.getActive() }
        });

        this.device.sendPacket(packet);
    },

    handlePacket: function (packet) {
        debug("Lock: handlePacket()");

//        return new Promise((resolve, reject) => {
//            // This is a request to change or report the local status
//            if (packet.type === "kdeconnect.lock.request") {
//                let respond = packet.body.hasOwnProperty("requestLocked");

//                if (packet.body.hasOwnProperty("setLocked")) {
//                    this._screensaver.setActive(packet.body.setLocked);
//                    respond = true;
//                }

//                if (respond) {
//                    this._response();
//                }
//            // This is an update about the remote status
//            } else if (packet.type === "kdeconnect.lock") {
//                this._locked = packet.body.isLocked;

//                this.notify("locked");
//            }
//        });
        //return new Promise.resolve(true);
    },

    destroy: function () {
        try {
            this._screensaver.disconnect(this._activeChanged);
        } catch (e) {
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

