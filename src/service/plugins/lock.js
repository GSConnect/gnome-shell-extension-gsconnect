"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Screen Lock"),
    description: _("Lock and unlock devices"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Lock",
    incomingPackets: ["kdeconnect.lock", "kdeconnect.lock.request"],
    outgoingPackets: ["kdeconnect.lock", "kdeconnect.lock.request"]
};


const ScreenSaverProxy = new Gio.DBusProxy.makeProxyWrapper(
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
        this._request();

        try {
            this._screensaver = new ScreenSaverProxy(
                Gio.DBus.session,
                "org.gnome.ScreenSaver",
                "/org/gnome/ScreenSaver",
                (proxy, error) => {
                    if (error === null) {
                        this._activeChanged = proxy.connectSignal(
                            "ActiveChanged",
                            (proxy, sender, [bool]) => {
                                this._response(bool);
                            }
                        );
                    }
                }
            );
        } catch (e) {
            this.destroy();
            throw Error("Lock: " + e.message);
        }
    },

    get locked () {
        return this._locked;
    },

    set locked (bool) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock.request",
            body: { setLocked: bool }
        });

        this.device._channel.send(packet);
    },

    _request: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock.request",
            body: { requestLocked: true }
        });

        this.device._channel.send(packet);
    },

    _response: function () {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock",
            body: { isLocked: this._screensaver.GetActiveSync() }
        });

        this.device._channel.send(packet);
    },

    handlePacket: function (packet) {
        debug("Lock: handlePacket()");

        // This is a request to change or report the local status
        if (packet.type === "kdeconnect.lock.request") {
            let respond = packet.body.hasOwnProperty("requestLocked");

            if (packet.body.hasOwnProperty("setLocked")) {
                this._screensaver.SetActiveSync(packet.body.setLocked);
                respond = true;
            }

            if (respond) {
                this._response();
            }
        // This is an update about the remote status
        } else if (packet.type === "kdeconnect.lock") {
            this._locked = packet.body.isLocked;

            this.notify("locked");
            this._dbus.emit_property_changed(
                "locked",
                new GLib.Variant("b", this._locked)
            );
        }
    },

    destroy: function () {
        try {
            this._screensaver.disconnectSignal(this._activeChanged);
        } catch (e) {
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

