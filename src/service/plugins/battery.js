'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;

const DBus = imports.modules.dbus;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Battery',
    incomingCapabilities: ['kdeconnect.battery', 'kdeconnect.battery.request'],
    outgoingCapabilities: ['kdeconnect.battery', 'kdeconnect.battery.request'],
    actions: {}
};


/**
 * Battery Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/battery
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectBatteryPlugin',
    Properties: {
        'charging': GObject.ParamSpec.boolean(
            'charging',
            'isCharging',
            'Whether the device is charging',
            GObject.ParamFlags.READABLE,
            false
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'IconName',
            'Icon name representing the battery state',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'level': GObject.ParamSpec.int(
            'level',
            'currentCharge',
            'Whether the device is charging',
            GObject.ParamFlags.READABLE,
            -1, 100,
            -1
        ),
        'time': GObject.ParamSpec.int(
            'time',
            'timeRemaining',
            'Seconds until full or depleted',
            GObject.ParamFlags.READABLE,
            -1, GLib.MAXINT32,
            -1
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'battery');

        // Export DBus
        this._dbus = new DBus.Interface({
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(
                'org.gnome.Shell.Extensions.GSConnect.Battery'
            )
        });
        this.device._dbus_object.add_interface(this._dbus);

        // Setup Cache
        this._chargeStats = [];
        this._dischargeStats = [];
        this._thresholdLevel = 25;

        this.cacheProperties([
            '_chargeStats',
            '_dischargeStats',
            '_thresholdLevel'
        ]);

        this.batteryRequest();

        // Local Battery (UPower)
        this._sendStatisticsId = this.settings.connect(
            'changed::send-statistics',
            this._onSendStatisticsChanged.bind(this)
        );
        this._onSendStatisticsChanged(this.settings);
    }

    get charging() {
        if (this._charging === undefined) {
            this._charging = false;
        }

        return this._charging;
    }

    get icon_name() {
        let icon;

        if (this.level === -1) {
            return 'battery-missing-symbolic';
        } else if (this.level === 100) {
            return 'battery-full-charged-symbolic';
        } else if (this.level < 3) {
            icon = 'battery-empty';
        } else if (this.level < 10) {
            icon = 'battery-caution';
        } else if (this.level < 30) {
            icon = 'battery-low';
        } else if (this.level < 60) {
            icon = 'battery-good';
        } else if (this.level >= 60) {
            icon = 'battery-full';
        }

        icon += this.charging ? '-charging-symbolic' : '-symbolic';
        return icon;
    }

    get level() {
        // This is what KDE Connect returns if the remote battery plugin is
        // disabled or still being loaded
        if (this._level === undefined) {
            this._level = -1;
        }

        return this._level;
    }

    get time() {
        if (this._time === undefined) {
            this._time = 0;
        }

        return this._time;
    }

    cacheLoaded() {
        this._extrapolateTime();

        this.notify('charging');
        this.notify('level');
        this.notify('icon-name');
        this.notify('time');
    }

    _onSendStatisticsChanged(settings) {
        if (this.settings.get_boolean('send-statistics')) {
            this._monitor();
        } else {
            this._unmonitor();
        }
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.battery') {
            this._handleUpdate(packet.body);
        } else if (packet.type === 'kdeconnect.battery.request') {
            this._handleRequest();
        }
    }

    /**
     * Report the local battery's current charge/state
     */
    _handleRequest() {
        if (!this._upower) { return; }

        debug([this._upower.percentage, this._upower.state]);

        let packet = {
            id: 0,
            type: 'kdeconnect.battery',
            body: {
                currentCharge: this._upower.percentage,
                isCharging: (this._upower.state !== UPower.DeviceState.DISCHARGING),
                thresholdEvent: 0
            }
        };

        if (this._upower.percentage === 15) {
            if (!packet.body.isCharging) {
                packet.body.thresholdEvent = 1;
            }
        }

        this.device.sendPacket(packet);
    }

    /**
     * Notify that the remote device considers the battery level low
     */
    _handleThreshold() {
        let buttons = [];

        // Offer the option to locate the device, if available
        if (this.device.get_action_enabled('find')) {
            buttons = [{
                label: _('Locate'),
                action: 'find',
                parameter: null
            }];
        }

        this.device.showNotification({
            id: 'battery|threshold',
            // TRANSLATORS: eg. Google Pixel: Battery is low
            title: _('%s: Battery is low').format(this.device.name),
            // TRANSLATORS: eg. 15% remaining
            body: _('%d%% remaining').format(this.level),
            icon: new Gio.ThemedIcon({ name: 'battery-caution-symbolic' }),
            buttons: buttons
        });

        // Save the threshold level
        this._thresholdLevel = this.level;
    }

    /**
     * Handle a remote battery update.
     *
     * @param {object} update - The body of a kdeconnect.battery packet
     */
    _handleUpdate(update) {
        if (update.thresholdEvent > 0) {
            this._handleThreshold();
        }

        if (this._charging !== update.isCharging) {
            this._charging = update.isCharging;
            this.notify('charging');
        }

        if (this._level !== update.currentCharge) {
            this._level = update.currentCharge;
            this.notify('level');

            if (this._level > this._thresholdLevel) {
                this.device.withdraw_notification('battery|threshold');
            }
        }

        this._logStatus(update.currentCharge, update.isCharging);

        this._time = this._extrapolateTime();
        this.notify('time');
        this.notify('icon-name');
    }

    /**
     * UPower monitoring methods
     */
    _monitor() {
        if (this.device.service.type !== 'laptop' || this._upower) {
            return;
        } else if (!this.device.get_incoming_supported('battery')) {
            debug('incoming battery statistics not supported', this.device.name);
            return;
        }

        try {
            this._upower = new UPower.Device();

            this._upower.set_object_path_sync(
                '/org/freedesktop/UPower/devices/DisplayDevice',
                null
            );

            this._upower._percentageId = this._upower.connect(
                'notify::percentage',
                this._handleRequest.bind(this)
            );

            this._upower._stateId = this._upower.connect(
                'notify::state',
                this._handleRequest.bind(this)
            );

            this._upower._warningId = this._upower.connect(
                'notify::warning_level',
                this._handleRequest.bind(this)
            );

            this._handleRequest();
        } catch(e) {
            logError(e, this.device.name);
            this._unmonitor();
        }
    }

    _unmonitor() {
        if (this.hasOwnProperty('_upower')) {
            this._upower.disconnect(this._upower._percentageId);
            this._upower.disconnect(this._upower._stateId);
            this._upower.disconnect(this._upower._warningId);
            delete this._upower;
        }
    }

    /**
     * Request the remote battery's current charge/state
     */
    batteryRequest() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.battery.request',
            body: { request: true }
        });
    }

    /**
     * Cache methods for battery statistics
     *
     * See also: https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/os/BatteryStats.java#1036
     */
    _logStatus(level, charging) {
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
    }

    _extrapolateTime() {
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
    }

    _limit_func() {
        // Limit stats to 3 days
        let limit = (Date.now() / 1000) - (3*24*60*60);

        return {
            charging: this._chargeStats.filter(stat => stat.time > limit),
            discharging: this._dischargeStats.filter(stat => stat.time > limit),
            threshold: this._thresholdLevel
        };
    }

    destroy() {
        this.settings.disconnect(this._sendStatisticsId);
        this._unmonitor();
        this.device._dbus_object.remove_interface(this._dbus);

        super.destroy();
    }
});

