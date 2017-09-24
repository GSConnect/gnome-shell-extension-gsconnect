"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

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

const Config = imports.service.config;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


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
    
    _init: function (device, name) {
        this.parent();
        this.device = device;
        this.name = name;
        
        this.export_interface();
        
        if (PluginInfo.get(this.name).hasOwnProperty("settings")) {
            this.settings = this.device.config.plugins[this.name].settings;
        }
    },
    
    export_interface: function () {
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect." + this.name;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    get incomingPackets() { throw Error("Not implemented"); },
    get outgoingPackets() { throw Error("Not implemented"); },
    
    handle_packet: function (packet) { throw Error("Not implemented"); },
    
    destroy: function () {
        this._dbus.unexport();
        delete this._dbus;
        // FIXME: signal handlers?
    },
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
        ),
        "threshold": GObject.ParamSpec.int(
            "threshold",
            "isCharging",
            "Whether the battery has reached the warning level",
            GObject.ParamFlags.READABLE,
            -1
        )
    },
    
    _init: function (device) {
        this.parent(device, "battery");
        
        this._charging = false;
        this._level = -1;
        this._threshold = 0;
    },
    
    get incomingPackets() {
        return ["kdeconnect.battery"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.battery.request"];
    },
    
    get charging() { return this._charging; },
    get level() { return this._level; },
    get threshold() { return this._threshold; },
    
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
        
        // FIXME: settings
        //        note clearing...
        this._threshold = packet.body.thresholdEvent;
        this._dbus.emit_property_changed(
            "threshold",
            new GLib.Variant("i", packet.body.thresholdEvent)
        );
        
        if (this.settings.threshold_notification) {
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: packet.id / 1000,
                summary: _("%s - Low Battery Warning").format(this.device.name),
                body: _("Battery level is %d").format(this.level), // FIXME % in format strings
                icon_name: "phone-symbolic"
            });
        } else if (this.level <= this.settings.threshold_level) {
        }
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
        this.parent(device, "findmyphone");
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
        this.parent(device, "notifications");
        
        this._freeze = false;
        this._notifications = new Map();
    },
    
    get incomingPackets() {
        return ["kdeconnect.notification"];
    },
    
    get outgoingPackets() {
        return [
            "kdeconnect.notification.request",
            "kdeconnect.notification.reply"
        ];
    },
    
    // TODO: consider option for notifications allowing clients to handle them
    handle_packet: function (packet) {
        log("IMPLEMENT: " + packet.toString());
        
        if (packet.body.isCancel && this._notifications.has(packet.body.id)) {
            // Dismissed
            // {"id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114","isCancel":true}
            this._notifications.get(packet.body.id).close();
            this._notifications.delete(packet.body.id);
        } else if (packet.body.hasOwnProperty("time")) {
            // Active
            // {"silent":true,
            //  "requestAnswer":true,
            //  "id":"0|org.kde.kdeconnect_tp|-1672895215|null|10114",
            //  "appName":"KDE Connect",
            //  "isClearable":true,
            //  "ticker":"Failed to send file to Gnome Shell ‐ exject2 (11)",
            //  "time":"1505860630584"}
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: packet.body.time / 1000,
                summary: packet.body.appName,
                body: packet.body.ticker,
                icon_name: "phone-symbolic"
            });
            
            this._notifications.set(packet.body.id, note);
            
            note.connect("closed", Lang.bind(this, this.close, packet.body.id));
            
            note.show();
        } else {
        }
    },
    
    close: function (notification, notificationId) {
        if (!this._freeze) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.notification.request";
            packet.body = { cancel: notificationId };
            
            this.device._channel.send(packet);
        }
    },
    
    // TODO: ???
    reply: function () {
    },
    
    // TODO: request notifications
    update: function () {
    },
    
    destroy: function () {
        this._freeze = true;
        
        for (let note of this._notifications.values()) {
            note.close();
        }
    
        PluginBase.prototype.destroy.call(this);
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
        this.parent(device, "ping");
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
    
    // TODO: support pings with messages
    ping: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.ping";
            
            this.device._channel.send(packet);
        }
    }
});


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommand
 *
 * TODO: some new stuff was added to git
 */
var RunCommandPlugin = new Lang.Class({
    Name: "GSConnectRunCommandPlugin",
    Extends: PluginBase,
    Signals: {
        "runcommand": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device) {
        this.parent(device, "remotecommand");
        //GLib.uuid_string_random();
    },
    
    get incomingPackets() {
        return ["kdeconnect.runcommand.request"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.runcommand"];
    },
    
    // TODO
    handle_packet: function (packet) {
        this.emit("runcommand");
        log("IMPLEMENT: " + packet.toString());
    },
    
    runcommand: function () {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.runcommand";
            
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
    
    MIN_PORT: 1739,
    MAX_PORT: 1764,
    
    _init: function (device) {
        this.parent(device, "share");
    },
    
    get incomingPackets() {
        return ["kdeconnect.share.request"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.share.request"];
    },
    
    handle_packet: function (packet) {
        // TODO: error checking, re-test
        if (packet.body.hasOwnProperty("filename")) {
            let filepath = this.get_filepath(packet.body.filename);
            let file = Gio.File.new_for_path(filepath);
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.identity.body.tcpHost
                ),
                port: packet.payloadTransferInfo.port
            });
            
            let channel = new Protocol.LanDownloadChannel(
                this.device,
                addr,
                file.replace(null, false, Gio.FileCreateFlags.NONE, null),
                packet.payloadSize
            );
            
            channel.open();
        } else if (packet.body.hasOwnProperty("text")) {
            log("IMPLEMENT: " + packet.toString());
            log("receiving text: '" + packet.body.text + "'");
        } else if (packet.body.hasOwnProperty("url")) {
            Gio.AppInfo.launch_default_for_uri(packet.body.url, null);
        }
    },
    
    get_filepath: function (filename) {
            let path = this.settings.download_directory
            
            if (this.settings.download_subdirs) {
                path = GLib.build_pathv("/", [
                    this.settings.download_directory,
                    this.device.id
                ]);
            }
            
            if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) {
                GLib.mkdir_with_parents(path, 493);
            }
            
            path = GLib.build_filenamev([path, filename]);
            
            let filepath = path.toString();
            let copyNum = 0;
            
            while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
                copyNum += 1;
                filepath = path + " (" + copyNum + ")";
            }
            
            return filepath;
    },
    
    share: function (uri) {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.share.request";
            
            if (uri.startsWith("file://")) {
                let file = Gio.File.new_for_uri(uri);
                let info = file.query_info("standard::size", 0, null);
                
                packet.body = { filename: file.get_basename() };
                packet.payloadSize = info.get_size();
                packet.payloadTransferInfo = { port: 1741 };
                
                let addr = new Gio.InetSocketAddress({
                    address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                    port: packet.payloadTransferInfo.port
                });
                
                let channel = new Protocol.LanUploadChannel(
                    this.device,
                    addr,
                    file.read(null),
                    packet.payloadSize
                );
                
                channel.open();
            } else {
                packet.body = { url: uri };
            }
            
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
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
            ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "telephony");
    },
    
    get incomingPackets() {
        return ["kdeconnect.telephony"];
    },
    
    get outgoingPackets() {
        return ["kdeconnect.telephony.request", "kdeconnect.sms.request"];
    },
    
    // TODO
    handle_packet: function (packet) {
        // There are six possible variables:
        //    * "event"             missedCall, ringing, sms or talking
        //    * "phoneNumber"       Always present?
        //    * "contactName"       Always present? (may be empty)
        //    * "messageBody"       SMS only?
        //    * "phoneThumbnail"    base64 ByteArray/Pixmap (may be empty)
        //    * "isCancel"          If true the packet should be ignored
        
        let sender, note;
        
         // FIXME: not sure what to do here...
//        if (!packet.body.phoneNumber.length) {
//            packet.body.phoneNumber = _("Unknown Number");
//        }
//        
//        if (packet.body.contactName === "") {
//            packet.body.contactName = _("Unknown Contact");
//        }
                
        if (packet.body.contactName.length) {
            sender = packet.body.contactName;
        } else {
            sender = packet.body.phoneNumber;
        }
        
        // Event handling
        if (packet.body.hasOwnProperty("isCancel") && packet.body.isCancel) {
            return;
        } else if (packet.body.event === "missedCall") {
            this._dbus.emit_signal("missedCall",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_missedCall) {
                note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s - Missed Call").format(this.device.name),
                    body: _("Missed call from %s").format(sender),
                    icon_name: "call-missed-symbolic"
                });
                
                note.show();
            }
        } else if (packet.body.event === "ringing") {
            this._dbus.emit_signal("ringing",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_ringing) {
                let note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s Ringing").format(this.device.name),
                    body: _("Incoming call from %s").format(sender),
                    icon_name: "call-start-symbolic"
                });
                
                note.add_action(
                    "notify_sms",
                    _("Mute"),
                    Lang.bind(this, this.mute)
                );
                
                note.show();
            }
        // TODO: not really complete
        } else if (packet.body.event === "sms") {
            this._dbus.emit_signal("sms",
                new GLib.Variant(
                    "(ssss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName,
                    packet.body.messageBody,
                    packet.body.phoneThumbnail] // FIXME: bytearray.pixmap
                )
            );
            
            // FIXME: check for open window
            //        urgency
            //        block matching notification somehow?
            if (this.settings.autoreply_sms) {
                this.reply(null, "autoreply_sms", packet.body);
            } else if (this.settings.notify_sms) {
                let sender;
                
                if (packet.body.contactName !== "") {
                    sender = packet.body.contactName;
                } else {
                    sender = packet.body.phoneNumber;
                }
            
                let note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: sender,
                    body: packet.body.messageBody,
                    icon_name: "phone-symbolic"
                });
                
                note.add_action(
                    "notify_sms", // action char
                    _("Reply"), // label
                    Lang.bind(this, this.reply, packet.body)
                );
                
                note.show();
            }
            
        } else if (packet.body.event === "talking") {
            this._dbus.emit_signal("talking",
                new GLib.Variant(
                    "(ss)",
                    [packet.body.phoneNumber,
                    packet.body.contactName]
                )
            );
            
            if (this.settings.notify_talking) {
                note = new Notify.Notification({
                    app_name: "GSConnect",
                    id: packet.id / 1000,
                    summary: _("%s - Talking").format(this.device.name),
                    body: _("Call in progress with %s").format(sender),
                    icon_name: "call-start-symbolic"
                });
                
                note.show();
            }
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
    
    reply: function (notification, action, user_data) {
        log("TelephonyPlugin._open_sms()");
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/sms.js --device=" + this.device.id
        );
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
 * Plugin handlers, mapped to plugin names with default settings
 *
 * FIXME: this stuff should all be programmatic like KDE Connect
 */
var PluginInfo = new Map([
    ["battery", {
        handler: BatteryPlugin,
        settings: {
            threshold_notification: true,
            threshold_level: -2
        }
    }],
    ["findmyphone", {
        handler: FindMyPhonePlugin
    }],
    ["notifications", {
        handler: NotificationsPlugin,
        settings: {}
    }],
    ["ping", {
        handler: PingPlugin
    }],
    ["runcommand", {
        handler: RunCommandPlugin,
        settings: {
            commands: {}
        }
    }],
    ["share", {
        handler: SharePlugin,
        settings: {
            download_directory: GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            ),
            download_subdirs: false
        }
    }],
    ["telephony", {
        handler: TelephonyPlugin,
        settings: {
            notify_missedCall: true,
            notify_ringing: true,
            notify_sms: true,
            autoreply_sms: false,
            notify_talking: true
        }
    }]
]);



