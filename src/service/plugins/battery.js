"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;

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
    summary: _("Battery"),
    description: _("Send and receive battery statistics"),
    dbusInterface: "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery",
    schemaId: "org.gnome.shell.extensions.gsconnect.plugin.battery",
    incomingPackets: ["kdeconnect.battery", "kdeconnect.battery.request"],
    outgoingPackets: ["kdeconnect.battery", "kdeconnect.battery.request"]
};


/**
 * Battery Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/battery
 */
var Plugin = new Lang.Class({
    Name: "GSConnectBatteryPlugin",
    Extends: PluginsBase.Plugin,
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
            "currentCharge",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            -1
        )
    },
    
    _init: function (device) {
        this.parent(device, "battery");
        
        this._charging = false;
        this._level = -1;
        
        if (this.settings.get_boolean("receive-statistics")) {
            this.request();
        }
        
        this.settings.connect("changed::receive-statistics", () => {
            if (this.settings.get_boolean("receive-statistics")) {
                this.request();
            } else {
                this._charging = false;
                this.notify("charging");
                this._dbus.emit_property_changed(
                    "charging",
                    new GLib.Variant("b", this._charging)
                );
                
                this._level = -1;
                this.notify("level");
                this._dbus.emit_property_changed(
                    "level",
                    new GLib.Variant("i", this._level)
                );
            }
        });
        
        if (this.settings.get_boolean("send-statistics") && this.device.daemon.type === "laptop") {
            this._monitor();
        }
        
        this.settings.connect("changed::send-statistics", () => {
            if (this.settings.get_boolean("send-statistics") && !this._battery) {
                this._monitor();
            } else if (!this.settings.get_boolean("send-statistics") && this._battery) {
                GObject.signal_handlers_destroy(this._battery);
                delete this._battery;
                delete this._gsd;
            }
        });
    },
    
    _monitor: function () {
        this._battery = new UPower.Device();
        
        try {
            this._battery.set_object_path_sync(
                "/org/freedesktop/UPower/devices/DisplayDevice",
                null
            );
            
            for (let property of ["percentage", "state", "warning_level"]) {
                this._battery.connect("notify::" + property, () => {
                    this.send();
                });
            }
            
            this._gsd = new Gio.Settings({
                schema_id: "org.gnome.settings-daemon.plugins.power"
            });
        } catch(e) {
            Common.debug("Battery: Failed to initialize UPower: " + e);
            GObject.signal_handlers_destroy(this._battery);
            delete this._battery;
            delete this._gsd;
        }
        
        this.send();
    },
    
    get charging() { return this._charging; },
    get level() { return this._level; },
    
    handlePacket: function (packet) {
        Common.debug("Battery: handlePacket()");
        
        if (packet.type === "kdeconnect.battery" && this.settings.get_boolean("receive-statistics")) {
            this.receive(packet);
        } else if (packet.type === "kdeconnect.battery.request" && this._battery) {
            this.send(packet);
        }
    },
    
    /**
     * Receive a remote battery update and disseminate the statistics
     */
    receive: function (packet) {
        Common.debug("Battery: receive()");
    
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
        
        if (packet.body.thresholdEvent > 0) {
            this.threshold();
        }
    },
    
    /**
     * Request the remote battery statistics
     */
    request: function () {
        Common.debug("Battery: request()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.battery.request",
            body: { request: true }
        });
        
        this.device._channel.send(packet);
    },
    
    /**
     * Report the local battery statistics to the device
     */
    send: function () {
        Common.debug("Battery: send()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.battery",
            body: {
                currentCharge: this._battery.percentage,
                isCharging: (this._battery.state !== UPower.DeviceState.DISCHARGING),
                thresholdEvent: 0
            }
        });
        
        if (this._battery.percentage === this._gsd.get_int("percentage-low")) {
            if (!packet.body.isCharging) {
                packet.body.thresholdEvent = 1;
            }
        }
        
        this.device._channel.send(packet);
    },
    
    /**
     * Notify about a remote threshold event (low battery level)
     */
    threshold: function () {
        Common.debug("Battery: threshold()");
        
        let notif = new Gio.Notification();
        // TRANSLATORS: Low Battery Warning
        notif.set_title(_("Low Battery Warning"));
        notif.set_body(
            // TRANSLATORS: eg. Google Pixel's battery level is 15%
            _("%s's battery level is %d%%").format(this.device.name, this.level)
        );
        notif.set_icon(new Gio.ThemedIcon({ name: "battery-caution-symbolic" }));
        
        if (this.device._plugins.has("findmyphone")) {
            notif.add_button(
                _("Locate"),
                "app.batteryWarning('" + this._dbus.get_object_path() + "')"
            );
        }
        
        this.device.daemon.send_notification("battery-warning", notif);
    },
    
    destroy: function () {
        if (this._battery) {
            GObject.signal_handlers_destroy(this._battery);
            delete this._battery;
        }
        
        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectBatterySettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (device, name, window) {
        this.parent(device, name, window);
        
        let generalSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        generalSection.addGSetting(this.settings, "receive-statistics");
        let send = generalSection.addGSetting(this.settings, "send-statistics");
        
        send.sensitive = (this.device.daemon.type === "laptop");
        
        this.content.show_all();
    }
});

