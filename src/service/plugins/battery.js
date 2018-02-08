"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery",
    incomingPackets: ["kdeconnect.battery", "kdeconnect.battery.request"],
    outgoingPackets: ["kdeconnect.battery", "kdeconnect.battery.request"]
};


var UUID = "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery";

var IncomingPacket = {
    BATTERY_UPDATE: "kdeconnect.battery",
    BATTERY_UPDATE_REQUEST: "kdeconnect.battery.request"
};

var OutgoingPacket = {
    BATTERY_UPDATE: "kdeconnect.battery",
    BATTERY_UPDATE_REQUEST: "kdeconnect.battery.request"
};

var Action = {
    // Sending an update
    provideUpdate: {
        label: _("Provide battery update"),
        incoming: ["kdeconnect.battery.request"],
        outgoing: ["kdeconnect.battery"]
    },
    // Request an update
    requestUpdate: {
        label: _("Request battery update"),
        incoming: ["kdeconnect.battery"],
        outgoing: ["kdeconnect.battery.request"]
    }
};

var Event = {
    // Sent an update
    BATTERY_UPDATE: "kdeconnect.battery",
    // A request for an update
    BATTERY_UPDATE_REQUEST: "kdeconnect.battery.request"
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
            -1, 100,
            -1
        ),
        "threshold": GObject.ParamSpec.int(
            "theshold",
            "thresholdLevel",
            "The level considered critical",
            GObject.ParamFlags.READABLE,
            -1, 100,
            25
        ),
        "time": GObject.ParamSpec.int(
            "time",
            "timeRemaining",
            "Seconds until full or depleted",
            GObject.ParamFlags.READABLE,
            -1, GLib.MAXINT32,
            -1
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

        this.cacheProperties([
            "_chargeStats",
            "_dischargeStats",
            "_thresholdLevel"
        ]);

        // Remote Battery
        this._charging = false;
        this.notify("charging", "b");
        this._level = -1;
        this.notify("level", "i");
        this._time = -1;
        this.notify("time", "i");
        this.requestUpdate();

        // Local Battery
        if ((this.allow & 2) && this.device.daemon.type === "laptop") {
            this._monitor();
        }

        this.settings.connect("changed::allow", () => {
            if ((this.allow & 2) && !this._battery) {
                this._monitor();
            } else if (!(this.allow & 2) && this._battery) {
                GObject.signal_handlers_destroy(this._battery);
                delete this._battery;
            }
        });
    },

    get charging() { return this._charging; },
    get level() { return this._level; },
    get time() { return this._time; },
    get threshold () { return this._thresholdLevel },

    /**
     * Packet dispatch
     */
    handlePacket: function (packet) {
        debug(packet);

        if (packet.type === "kdeconnect.battery" && (this.allow & 4)) {
            return this._handleUpdate(packet.body);
        } else if (packet.type === "kdeconnect.battery.request" && (this.allow & 2)) {
            return this._provideUpdate();
        } else {
            return Promise.reject(new Error("Operation not permitted: " + packet.type));
        }
    },

    /**
     * Local Methods
     */
    _monitor: function () {
        // FIXME
        if (this.device.incomingCapabilities.indexOf("kdeconnect.battery") < 0) {
            return;
        }

        try {
            this._battery = new UPower.Device();

            this._battery.set_object_path_sync(
                "/org/freedesktop/UPower/devices/DisplayDevice",
                null
            );

            for (let property of ["percentage", "state", "warning_level"]) {
                this._battery.connect("notify::" + property, () => {
                    this._provideUpdate();
                });
            }

            this._provideUpdate();
        } catch(e) {
            debug("Battery: Failed to initialize UPower: " + e);
            GObject.signal_handlers_destroy(this._battery);
            delete this._battery;
        }
    },

    _provideUpdate: function () {
        debug([this._battery.percentage, this._battery.state]);

        if (!this._battery) { return; }

        // TODO: error handling?
        return new Promise((resolve, reject) => {
            let packet = {
                id: 0,
                type: "kdeconnect.battery",
                body: {
                    currentCharge: this._battery.percentage,
                    isCharging: (this._battery.state !== UPower.DeviceState.DISCHARGING),
                    thresholdEvent: 0
                }
            };

            if (this._battery.percentage === 15) {
                if (!packet.body.isCharging) {
                    packet.body.thresholdEvent = 1;
                }
            }

            this.sendPacket(packet);

            resolve(true);
        });
    },

    /**
     * Remote methods
     */
    _handleUpdate: function (update) {
        debug(update);

        // TODO: error handling?
        return new Promise((resolve, reject) => {
            if (update.thresholdEvent > 0) {
                this._handleThreshold();
            }

            if (this._charging !== update.isCharging) {
                this._charging = update.isCharging;
                this.notify("charging", "b");
            }

            if (this._level !== update.currentCharge) {
                this._level = update.currentCharge;
                this.notify("level", "i");

                if (this._level > this._thresholdLevel) {
                    this.device.withdraw_notification("battery|threshold");
                }
            }

            this.addStat(update.currentCharge, this.charging);

            this._time = this._extrapolateTime();
            this.notify("time", "i");

            resolve(true);
        });
    },

    _handleThreshold: function () {
        debug(this._level);

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
                "app.deviceAction(('" +
                this._dbus.get_object_path() +
                "','" +
                "find" +
                "','" +
                "{}" +
                "'))"
            );
        }

        this.device.send_notification("battery|threshold", notif);

        this._thresholdLevel = this.level;
    },

    /**
     * Request the remote battery statistics
     */
    requestUpdate: function () {
        debug("");

        this.sendPacket({
            id: 0,
            type: "kdeconnect.battery.request",
            body: { request: true }
        });
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

    _extrapolateTime: function () {
        let tdelta, ldelta;
        let rate = 0;
        let time = 0;

        let stats = (this.charging) ? this._chargeStats : this._dischargeStats;

        for (let i = 0; i + 1 <= stats.length - 1; i++) {
            tdelta = stats[i + 1].time - stats[i].time;

            if (this.charging) {
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

        if (rate && this.charging) {
            time = rate * (100 - stats[stats.length - 1].level);
        } else if (rate && !this.charging) {
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

