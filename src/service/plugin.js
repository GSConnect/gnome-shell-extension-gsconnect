"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Notify = imports.gi.Notify;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());
imports.searchPath.push(getPath() + "/service");

const Config = imports.config;
const Protocol = imports.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.lib;


/**
 * Base class for plugins
 *
 * TODO: common functions for export/unexport dbus
 *       auto-call PropertiesChanged?
 *       make more "introspectable"?
 */
var PluginBase = new Lang.Class({
    Name: "GSConnectPluginBase",
    Extends: GObject.Object,
    Properties: {
        "incomingPacket": GObject.param_spec_variant(
            "incomingPackets",
            "DevicesList", 
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "outgoingPackets": GObject.param_spec_variant(
            "outgoingPackets",
            "DevicesList", 
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    
    get incomingPackets() {
        throw Error("Not implemented");
    },
    
    get outgoingPackets() {
        throw Error("Not implemented");
    },
    
    handle_packet: function (packet) {
        throw Error("Not implemented");
    }
});


/**
 * Battery Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/battery
 */
var BatteryPlugin = new Lang.Class({
    Name: "GSConnectBatteryPlugin",
    Extends: PluginBase,
    Properties: {
        "charging": GObject.ParamSpec.boolean(
            "charging",
            "isCharging",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            false
        ),
        "level": GObject.ParamSpec.int(
            "level",
            "isCharging",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            -1
        )
    },
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        this._charging = false;
        this._level = -1;
        this._threshold = 0;
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.battery";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return ["kdeconnect.battery"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.battery.request"];
    },
    
    get charging() {
        return this._charging;
    },
    
    get level() {
        return this._level;
    },
    
    handle_packet: function (packet) {
        this._charging = packet.body.isCharging;
        this.notify("charging");
        this._dbus.emit_property_changed(
            "charging",
            new GLib.Variant("b", packet.body.isCharging)
        );
        
        this._level = packet.body.currentCharge;
        this.notify("level");
        this._dbus.emit_property_changed(
            "level",
            new GLib.Variant("i", packet.body.currentCharge)
        );
        
        // TODO: thresholdEvent {int} means that a battery threshold event was
        //       fired on the remote device:
        //           0 := no event. generally not transmitted.
        //           1 := battery entered in low state
        //this._threshold = packet.body.thresholdEvent;
    },
    
    /**
     * Request an update
     * TODO: test/check this works
     */
    update: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.battery.request";
            packet.body = { request: true };
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * FindMyPhone Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/findmyphone
 */
var FindMyPhonePlugin = new Lang.Class({
    Name: "GSConnectFindMyPhonePlugin",
    Extends: PluginBase,
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.findmyphone";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return [];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.findmyphone.request"];
    },
    
    handle_packet: function (packet) {
        log("This should never be called since there is no incoming packet");
    },
    
    ring: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.findmyphone.request";
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notification
 *
 * TODO: pretty much all of it
 */
var NotificationsPlugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginBase,
    Signals: {
        "notificationReceived": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "notificationDismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "notificationsDismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
    },
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        this._notifications = new Map();
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.notifications";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return ["kdeconnect.notification"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.notification.request"];
    },
    
    // TODO: consider option for notifications allowing clients to handle them
    handle_packet: function (packet) {
        log("IMPLEMENT: " + packet.toString());
        
        // Active
        // {"silent":true,
        //  "requestAnswer":true,
        //  "id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114",
        //  "appName":"KDE Connect",
        //  "isClearable":true,
        //  "ticker":"Failed to send file to Gnome Shell ‐ exject2 (11)",
        //  "time":"1505860630584"}
//        let note = new Notify.Notification({
//            id: packet.body.time / 1000,
//            summary: packet.body.appName,
//            body: packet.body.ticker,
//            icon_name: "phone-symbolic"
//        });
//        
//        note.show();
        let note = new Gio.Notification();
        note.set_title(packet.body.appName);
        note.set_body(packet.body.ticker);
        this.device.daemon.send_notification(packet.body.id, note);
        
        // Dismissed
        // {"id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114","isCancel":true}
    },
    
    // TODO: kdeconnect.notification.request packet?
    notifications: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            return [];
        }
    }
});


/**
 * Ping Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/ping
 */
var PingPlugin = new Lang.Class({
    Name: "GSConnectPingPlugin",
    Extends: PluginBase,
    Signals: {
        "ping": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.ping";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return ["kdeconnect.ping"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.ping"];
    },
    
    // TODO: support pings with messages
    handle_packet: function (packet) {
        this.emit("ping");
        log("IMPLEMENT: " + packet.toString());
    },
    
    ping: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.ping";
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 */
var SharePlugin = new Lang.Class({
    Name: "GSConnectSharePlugin",
    Extends: PluginBase,
    Signals: {
        "share": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.share";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return ["kdeconnect.share.request"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.share.request"];
    },
    
    // TODO
    handle_packet: function (packet) {
        this.emit("share");
        log("IMPLEMENT: " + packet.toString());
        
        if (packet.body.hasOwnProperty("filename")) {
            log("receiving file");
            //"payloadSize":648,"payloadTransferInfo":{"port":1740}
            
            let path = "/home/andrew/test.download.txt";
            
            this.localFile = Gio.File.new_for_path(path);
            this.fStream = this.localFile.replace(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
            
            let channel = new Protocol.TransferChannel(
                this.device,
                packet.payloadTransferInfo.port,
                null,
                this.fStream
            );
            
            channel.open();
        } else if (packet.body.hasOwnProperty("text")) {
            log("receiving text: '" + packet.body.text + "'");
        } else if (packet.body.hasOwnProperty("url")) {
            log("receiving url");
            GLib.spawn_command_line_async("xdg-open " + packet.body.url);
        }
    },
    
    shareUrl: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.share.request";
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 */
var TelephonyPlugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginBase,
    Signals: {
        "telephony": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent();
        
        this.device = device;
        
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect.telephony";
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() {
        return ["kdeconnect.telephony"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.telephony.request", "kdeconnect.sms.request"];
    },
    
    // TODO
    handle_packet: function (packet) {
        this.emit("telephony");
        log("IMPLEMENT: " + packet.toString());
        
        // Apparently there are six possible variables:
        //    * "event"             Always present
        //    * "phoneNumber"       Always present? (Could contain contactName?)
        //    * "contactName"       Not seen yet
        //    * "messageBody"       SMS only, I think
        //    * "phoneThumbnail"    Not seen yet, base64 encoded ByteArray (Pixmap?)
        //    * "isCancel"          If set to true, the package should be ignored
        if (packet.body.hasOwnProperty("isCancel") && packet.body.isCancel) {
            return;
        } else if (packet.body.event === "missedCall") {
            log("Missed Call...");
        } else if (packet.body.event === "ringing") {
            log("Ringing...");
            // It's possible to reply with a "mute" packet
            //this.mute();
        } else if (packet.body.event === "sms") {
            log("SMS Received:");
            log("    phoneNumber => " + packet.body.phoneNumber);
            log("    messageBody => " + packet.body.messageBody);
            //log("    contactName => " + packet.body.contactName);
            //log("    phoneThumbnail => " + packet.body.phoneThumbnail);
            
        } else if (packet.body.event === "talking") {
            log("Talking...");
        } else {
            log("Unknown telephony event: " + packet.body.event);
        }
    },
    
    // TODO: test, but how? no one calls me!
    mute: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.telephony.request"
            packet.body = { action: "mute" };
            this.device._channel.send(packet);
        }
    },
    
    sms: function (phoneNumber, messageBody) {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.sms.request";
            
            packet.body = {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            };
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * Plugin handlers, mapped to incoming packet types (remote outgoingCapabilities)
 */
var PluginMap = new Map([
    ["battery", BatteryPlugin],
    ["findmyphone", FindMyPhonePlugin],
    ["notifications", NotificationsPlugin],
    ["ping", PingPlugin],
    ["share", SharePlugin],
    ["telephony", TelephonyPlugin]
]);



