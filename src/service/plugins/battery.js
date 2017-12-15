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
        ),
        "time": GObject.ParamSpec.int(
            "time",
            "timeRemaining",
            "Seconds until full or depleted",
            GObject.ParamFlags.READABLE,
            0
        )
    },
    
    _init: function (device) {
        this.parent(device, "battery");
        
        this._charging = false;
        this._level = -1;
        this._time = 0;
        this._stats = [];
        
        if (this.settings.get_boolean("receive-statistics")) {
            this.request();
        }
        
        this.settings.connect("changed::receive-statistics", () => {
            if (this.settings.get_boolean("receive-statistics")) {
                this._stats = [];
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
                
                this._time = 0;
                this.notify("time");
                this._dbus.emit_property_changed(
                    "level",
                    new GLib.Variant("i", this._time)
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
            }
        });
    },
    
    _monitor: function () {
        try {
            this._battery = new UPower.Device();

            this._battery.set_object_path_sync(
                "/org/freedesktop/UPower/devices/DisplayDevice",
                null
            );
            
            for (let property of ["percentage", "state", "warning_level"]) {
                this._battery.connect("notify::" + property, () => {
                    this.send();
                });
            }

            this.send();
        } catch(e) {
            Common.debug("Battery: Failed to initialize UPower: " + e);
            GObject.signal_handlers_destroy(this._battery);
            delete this._battery;
        }
    },
    
    _extrapolate: function (time, level) {
        this._stats.push({
            time: Math.floor(Date.now() / 1000),
            level: this._level
        });
        
        // Limit extraneous samples to a relative age of 5 minutes
        while (this._stats.length > 2) {
            if ((this._stats[1].time - this._stats[0].time) < 300) {
                break;
            }
            
            this._stats.shift();
        }
        
        this._time = 0;
        
        if (this._stats.length > 1) {
            let last = this._stats.length - 1;
            let tdelta = this._stats[last].time - this._stats[0].time;
            let ldelta, time;
            
            if (this.charging) {
                ldelta = this._stats[last].level - this._stats[0].level;
                time = (tdelta/ldelta) * (100 - this.level);
            } else {
                ldelta = this._stats[0].level - this._stats[last].level;
                time = (tdelta/ldelta) * this.level;
            }
            
            this._time = (time === NaN) ? 0 : time;
        }
        
        this.notify("time");
        this._dbus.emit_property_changed(
            "time",
            new GLib.Variant("i", this._time)
        );
    },
    
    get charging() { return this._charging; },
    get level() { return this._level; },
    get time() { return this._time; },
    
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
        
        if (packet.body.thresholdEvent > 0) {
            this.threshold();
        }
    
        if (this._charging !== packet.body.isCharging) {
            this._charging = packet.body.isCharging;
            this.notify("charging");
            this._dbus.emit_property_changed(
                "charging",
                new GLib.Variant("b", packet.body.isCharging)
            );
            this._stats = [];
        }
        
        this._level = packet.body.currentCharge;
        this.notify("level");
        this._dbus.emit_property_changed(
            "level",
            new GLib.Variant("i", packet.body.currentCharge)
        );
        
        this._extrapolate();
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
        
        if (!this._battery) { return; }
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.battery",
            body: {
                currentCharge: this._battery.percentage,
                isCharging: (this._battery.state !== UPower.DeviceState.DISCHARGING),
                thresholdEvent: 0
            }
        });

        if (this._battery.percentage === 15) {
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

