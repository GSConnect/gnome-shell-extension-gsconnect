'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Battery',
    incomingCapabilities: ['kdeconnect.battery', 'kdeconnect.battery.request'],
    outgoingCapabilities: ['kdeconnect.battery', 'kdeconnect.battery.request'],
    actions: {
        batteryReport: {
            summary: _('Report Battery'),
            description: _('Provide battery update'),
            icon_name: 'battery-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.battery.request'],
            outgoing: ['kdeconnect.battery']
        },
        batteryRequest: {
            summary: _('Update Battery'),
            description: _('Request battery update'),
            icon_name: 'battery-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.battery'],
            outgoing: ['kdeconnect.battery.request']
        }
    }
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
        'threshold': GObject.ParamSpec.int(
            'theshold',
            'thresholdLevel',
            'The level considered critical',
            GObject.ParamFlags.READABLE,
            -1, 100,
            25
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
            g_interface_info: gsconnect.dbusinfo.lookup_interface(Metadata.id),
            g_instance: this
        });
        this.device._dbus_object.add_interface(this._dbus);

        this._charging = false;
        this._level = -1;
        this._time = 0;

        this._chargeStats = [];
        this._dischargeStats = [];
        this._thresholdLevel = 25;

        this.cacheProperties([
            '_chargeStats',
            '_dischargeStats',
            '_thresholdLevel'
        ]);

        // Remote Battery
        this.notify('charging');
        this.notify('level');
        this.notify('time');
        this.notify('icon-name');

        this.batteryRequest();

        // Local Battery (UPower)
        if (this.device.service.type === 'laptop') {
            this._monitor();
        }

    }

    get charging() { return this._charging || false; }
    get icon_name() {
        let icon = 'battery';

        if (this.level === -1) {
            return 'battery-missing-symbolic';
        } else if (this.level === 100) {
            return 'battery-full-charged-symbolic';
        } else if (this.level < 3) {
            icon += '-empty';
        } else if (this.level < 10) {
            icon += '-caution';
        } else if (this.level < 30) {
            icon += '-low';
        } else if (this.level < 60) {
            icon += '-good';
        } else if (this.level >= 60) {
            icon += '-full';
        }

        icon += (this._charging) ? '-charging-symbolic' : '-symbolic';
        return icon;
    }
    get level() {
        if (this._level === undefined) {
            return -1;
        }

        return this._level;
    }
    get time() { return this._time || 0; }
    get threshold () { return this._thresholdLevel }

    /**
     * Packet dispatch
     */
    handlePacket(packet) {
        debug(packet);

        if (packet.type === 'kdeconnect.battery') {
            return this._handleUpdate(packet.body);
        } else if (packet.type === 'kdeconnect.battery.request') {
            return this.requestUpdate();
        }
    }

    /**
     * Remote methods
     */
    _handleUpdate(update) {
        debug(update);

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

        //this._icon_name = this._updateIcon();
        this.notify('icon-name');

        this._time = this._extrapolateTime();
        this.notify('time');
    }

    _handleThreshold() {
        debug(this._level);

        let buttons = [];

        if (this.device.get_action_enabled('find')) {
            buttons = [{
                label: _('Locate'),
                action: 'find',
                parameter: new GLib.Variant('mv', null)
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

        this._thresholdLevel = this.level;
    }

    /**
     * Local Methods
     */
    _monitor() {
        // FIXME
        let action = this.device.lookup_action('reportStatus');

        if (!action || !action.enabled) {
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
                this.reportStatus.bind(this)
            );

            this._upower._stateId = this._upower.connect(
                'notify::state',
                this.reportStatus.bind(this)
            );

            this._upower._warningId = this._upower.connect(
                'notify::warning_level',
                this.reportStatus.bind(this)
            );

            this.reportStatus();
        } catch(e) {
            debug('Battery: Failed to initialize UPower: ' + e.message);
            this._unmonitor();
        }
    }

    _unmonitor() {
        if (this._upower) {
            this._upower.disconnect(this._upower._percentageId);
            this._upower.disconnect(this._upower._stateId);
            this._upower.disconnect(this._upower._warningId);
            delete this._upower;
        }
    }

    /**
     * Report the local battery's current charge/state
     */
    batteryReport() {
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
        this._unmonitor();
        this.device._dbus_object.remove_interface(this._dbus);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

