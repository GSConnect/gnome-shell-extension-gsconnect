"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Battery"),
    description: _("Send and receive battery statistics"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery",
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

        this._chargeStats = [];
        this._dischargeStats = [];
        this._thresholdLevel = 25;

        this.initPersistence([
            "_chargeStats",
            "_dischargeStats",
            "_thresholdLevel"
        ]);

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

                this.notify("time");
                this._dbus.emit_property_changed(
                    "time",
                    new GLib.Variant("i", this.time)
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
            debug("Battery: Failed to initialize UPower: " + e);
            GObject.signal_handlers_destroy(this._battery);
            delete this._battery;
        }
    },

    get charging() { return this._charging; },
    get level() { return this._level; },
    get time() { return this._time; },

    handlePacket: function (packet) {
        debug("Battery: handlePacket()");

        if (packet.type === "kdeconnect.battery" && this.settings.get_boolean("receive-statistics")) {
            this.receive(packet);
        } else if (packet.type === "kdeconnect.battery.request" && this._battery) {
            this.send();
        }
    },

    /**
     * Receive a remote battery update and disseminate the statistics
     */
    receive: function (packet) {
        debug("Battery: receive()");

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
        }

        if (this._level !== packet.body.currentCharge) {
            this._level = packet.body.currentCharge;
            this.notify("level");
            this._dbus.emit_property_changed(
                "level",
                new GLib.Variant("i", packet.body.currentCharge)
            );

            if (this._level > this._thresholdLevel) { // TODO
                this.device.withdraw_notification("battery|threshold");
            }
        }

        this.addStat(packet.body.currentCharge, this.charging);

        this._time = this.getTime(this.charging);
        this.notify("time");
        this._dbus.emit_property_changed(
            "time",
            new GLib.Variant("i", this.time)
        );
    },

    /**
     * Request the remote battery statistics
     */
    request: function () {
        debug("Battery: request()");

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
        debug("Battery: send()");

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
        debug("Battery: threshold()");

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

        this.device.send_notification("battery|threshold", notif);

        this._thresholdLevel = this.level;
    },

    /**
     * Cache methods for battery statistics
     *
     * See also: https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/os/BatteryStats.java#1036
     */
    addStat: function (level, charging) {
        // Edge case
        if (!level) {
            return;
        // Reset stats when fully charged
        } else if (level === 100) {
            this._chargeStats.length = 0;
            this._dischargeStats.length = 0;
        }

        let stats = (charging) ? this._chargeStats : this._dischargeStats;
        let time = Math.floor(Date.now() / 1000);

        if (!stats.length) {
            stats.push({ time: time, level: level });
        } else if (stats[stats.length - 1].level !== level) {
            stats.push({ time: time, level: level });
        }
    },

    getTime: function (charging) {
        let tdelta, ldelta;
        let rate = 0;
        let time = 0;

        let stats = (charging) ? this._chargeStats : this._dischargeStats;

        for (let i = 0; i + 1 <= stats.length - 1; i++) {
            tdelta = stats[i + 1].time - stats[i].time;

            if (charging) {
                ldelta = stats[i + 1].level - stats[i].level;
            } else {
                ldelta = stats[i].level - stats[i + 1].level;
            }

            if (ldelta > 0 && rate > 0) {
                rate = (rate * 0.4) + ((tdelta/ldelta) * 0.6);
            } else if (ldelta > 0) {
                rate = tdelta/ldelta;
            }
        }

        if (rate && charging) {
            time = rate * (100 - stats[stats.length - 1].level);
        } else if (rate && !charging) {
            time = rate * stats[stats.length - 1].level;
        }

        return (time === NaN) ? 0 : Math.floor(time);
    },

    _limit_func: function () {
        // Limit stats to 3 days
        let limit = (Date.now() / 1000) - (3*24*60*60);

        return {
            charging: this._chargeStats.filter(stat => stat.time > limit),
            discharging: this._dischargeStats.filter(stat => stat.time > limit),
            threshold: this._thresholdLevel
        };
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

