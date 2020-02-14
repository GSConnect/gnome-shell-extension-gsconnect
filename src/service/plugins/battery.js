'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Battery'),
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
    GTypeName: 'GSConnectBatteryPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'battery');

        // Setup Cache; defaults are 90 minute charge, 1 day discharge
        this._chargeState = [54, 0, -1];
        this._dischargeState = [864, 0, -1];
        this._thresholdLevel = 25;

        this.cacheProperties([
            '_chargeState',
            '_dischargeState',
            '_thresholdLevel'
        ]);

        // Export battery state as GAction
        this.__state = new Gio.SimpleAction({
            name: 'battery',
            parameter_type: new GLib.VariantType('(bsii)'),
            state: this.state
        });
        this.device.add_action(this.__state);

        // Local Battery (UPower)
        this._upowerId = 0;
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

    get state() {
        return new GLib.Variant(
            '(bsii)',
            [this.charging, this.icon_name, this.level, this.time]
        );
    }

    clearCache() {
        this._chargeState = [54, 0, -1];
        this._dischargeState = [864, 0, -1];
        this._thresholdLevel = 25;
        this._estimateTime();

        this.__cache_write();
    }

    cacheLoaded() {
        this._estimateTime();
        this.connected();
    }

    _onSendStatisticsChanged() {
        if (this.settings.get_boolean('send-statistics')) {
            this._monitorState();
        } else {
            this._unmonitorState();
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.battery':
                this._receiveState(packet);
                break;

            case 'kdeconnect.battery.request':
                this._sendState();
                break;
        }
    }

    connected() {
        super.connected();

        this._requestState();
        this._sendState();
    }

    /**
     * Notify that the remote device considers the battery level low
     */
    _batteryNotification(event, title, body, iconName) {
        let buttons = [];

        // Offer the option to ring the device, if available
        if (this.device.get_action_enabled('ring')) {
            buttons = [{
                label: _('Ring'),
                action: 'ring',
                parameter: null
            }];
        }

        this.device.showNotification({
            id: `battery|${event}`,
            title: title,
            body: body,
            icon: new Gio.ThemedIcon({name: iconName}),
            buttons: buttons
        });

        // Save the threshold level
        this._thresholdLevel = this.level;
    }

    _lowBatteryNotification() {
        if (!this.settings.get_boolean('low-battery-notification')) {
            return;
        }

        this._batteryNotification(
            'battery|low',
            // TRANSLATORS: eg. Google Pixel: Battery is low
            _('%s: Battery is low').format(this.device.name),
            // TRANSLATORS: eg. 15% remaining
            _('%d%% remaining').format(this.level),
            'battery-caution-symbolic'
        );

        // Save the threshold level
        this._thresholdLevel = this.level;
    }

    _fullBatteryNotification() {
        if (!this.settings.get_boolean('full-battery-notification')) {
            return;
        }

        this._batteryNotification(
            'battery|full',
            // TRANSLATORS: eg. Google Pixel: Battery is full
            _('%s: Battery is full').format(this.device.name),
            // TRANSLATORS: when the battery is fully charged
            _('Fully Charged'),
            'battery-full-charged-symbolic'
        );
    }

    /**
     * Handle a remote battery update.
     *
     * @param {kdeconnect.battery} packet - A kdeconnect.battery packet
     */
    _receiveState(packet) {
        // Charging state changed
        this._charging = packet.body.isCharging;

        // Level changed
        if (this._level !== packet.body.currentCharge) {
            this._level = packet.body.currentCharge;

            // If the level is above the threshold hide the notification
            if (this._level > this._thresholdLevel) {
                this.device.hideNotification('battery|low');
            }

            // If the level just changed to full show a notification
            if (this._level === 100) {
                this._fullBatteryNotification();

            // Otherwise hide it
            } else {
                this.device.hideNotification('battery|full');
            }
        }

        // Device considers the level low
        if (packet.body.thresholdEvent > 0) {
            this._lowBatteryNotification();
        }

        this._updateEstimate();

        this.__state.state = this.state;
    }

    /**
     * Request the remote battery's current charge/state
     */
    _requestState() {
        this.device.sendPacket({
            type: 'kdeconnect.battery.request',
            body: {request: true}
        });
    }

    /**
     * Report the local battery's current charge/state
     */
    _sendState() {
        if (this._upowerId === 0) {
            return;
        }

        let upower = this.service.components.get('upower');

        if (upower) {
            this.device.sendPacket({
                type: 'kdeconnect.battery',
                body: {
                    currentCharge: upower.level,
                    isCharging: upower.charging,
                    thresholdEvent: upower.threshold
                }
            });
        }
    }

    /**
     * UPower monitoring methods
     */
    _monitorState() {
        try {
            let upower = this.service.components.get('upower');
            let incoming = this.device.settings.get_strv('incoming-capabilities');

            switch (true) {
                case (!incoming.includes('kdeconnect.battery')):
                case (this._upowerId > 0):
                case (!upower):
                case (!upower.is_present):
                    return;
            }

            this._upowerId = upower.connect(
                'changed',
                this._sendState.bind(this)
            );

            this._sendState();
        } catch (e) {
            logError(e, this.device.name);
            this._unmonitorState();
        }
    }

    _unmonitorState() {
        try {
            if (this._upowerId > 0) {
                let upower = this.service.components.get('upower');

                if (upower) {
                    upower.disconnect(this._upowerId);
                }

                this._upowerId = 0;
            }
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /**
     * Recalculate the (dis)charge rate and update the estimated time remaining
     * See also: https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/os/BatteryStats.java#1036
     */
    _updateEstimate() {
        let new_time = Math.floor(Date.now() / 1000);
        let new_level = this.level;

        // Read the state; rate has a default, time and level default to current
        let [rate, time, level] = this.charging ? this._chargeState : this._dischargeState;
        time = (Number.isFinite(time) && time > 0) ? time : new_time;
        level = (Number.isFinite(level) && level > -1) ? level : new_level;

        if (!Number.isFinite(rate) || rate < 1) {
            rate = this.charging ? 54 : 864;
        }

        // Derive rate from time/level diffs (rate = seconds/percent)
        let ldiff = this.charging ? new_level - level : level - new_level;
        let tdiff = new_time - time;
        let new_rate = tdiff / ldiff;

        // Update the rate if it seems valid. Use a weighted average in favour
        // of the new rate to account for possible missed level changes
        if (new_rate && Number.isFinite(new_rate)) {
            rate = Math.floor((rate * 0.4) + (new_rate * 0.6));
        }

        // Save the state
        if (this.charging) {
            this._chargeState = [rate, new_time, new_level];
        } else {
            this._dischargeState = [rate, new_time, new_level];
        }

        // Notify of the change
        if (rate && this.charging) {
            this._time = Math.floor(rate * (100 - new_level));
        } else if (rate && !this.charging) {
            this._time = Math.floor(rate * new_level);
        }
    }

    /**
     * Calculate and update the estimated time remaining, without affecting the
     * (dis)charge rate.
     */
    _estimateTime() {
        // elision (rate, time, level)
        let [rate,, level] = this.charging ? this._chargeState : this._dischargeState;
        level = (level > -1) ? level : this.level;

        if (!Number.isFinite(rate) || rate < 1) {
            rate = this.charging ? 864 : 90;
        }

        if (rate && this.charging) {
            this._time = Math.floor(rate * (100 - level));
        } else if (rate && !this.charging) {
            this._time = Math.floor(rate * level);
        }

        this.__state.state = this.state;
    }

    destroy() {
        this.settings.disconnect(this._sendStatisticsId);
        this._unmonitorState();
        this.device.remove_action('battery');

        super.destroy();
    }
});

