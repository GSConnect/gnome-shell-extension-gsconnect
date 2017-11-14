"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Screen Lock"),
    description: _("Lock and unlock devices"),
    dbusInterface: "org.gnome.Shell.Extensions.GSConnect.Plugin.Lock",
    schemaId: "org.gnome.shell.extensions.gsconnect.plugin.lock",
    incomingPackets: ["kdeconnect.lock", "kdeconnect.lock.request"],
    outgoingPackets: ["kdeconnect.lock", "kdeconnect.lock.request"]
};


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
        
        this._screensaver = new Common.DBusProxy.screensaver(
            Gio.DBus.session,
            "org.gnome.ScreenSaver",
            "/org/gnome/ScreenSaver"
        );
        this._screensaver.connectSignal("ActiveChanged", (proxy, sender, [bool]) => {
            this._response(bool);
        });
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
    
    _response: function (bool) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.lock",
            body: { isLocked: bool }
        });
        
        this.device._channel.send(packet);
    },
    
    handlePacket: function (packet) {
        Common.debug("Lock: handlePacket()");
        
        if (packet.type === "kdeconnect.lock.request") {
            let respond = packet.body.hasOwnProperty("requestLocked");
            
            if (packet.body.hasOwnProperty("setLocked")) {
                this._screensaver.SetActiveSync(packet.body.setLocked);
                respond = true;
            }
            
            if (respond) {
                this._response(this._screensaver.GetActiveSync());
            }
        } else if (packet.type === "kdeconnect.lock") {
            this._locked = packet.body.isLocked;
        
            this.notify("locked");
            this._dbus.emit_property_changed(
                "locked",
                new GLib.Variant("b", this._locked)
            );
        }
    }
});

