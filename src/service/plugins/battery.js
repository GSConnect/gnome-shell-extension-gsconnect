'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Battery'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Battery',
    incomingCapabilities: [
        'kdeconnect.battery',
        'kdeconnect.battery.request',
    ],
    outgoingCapabilities: [
        'kdeconnect.battery',
        'kdeconnect.battery.request',
    ],
    actions: {},
};


/**
 * Battery Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/battery
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectBatteryPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'battery');

        // Setup Cache; defaults are 90 minute charge, 1 day discharge
        this._chargeState = [54, 0, -1];
        this._dischargeState = [864, 0, -1];
        this._thresholdLevel = 25;

        this.cacheProperties([
            '_chargeState',
            '_dischargeState',
            '_thresholdLevel',
        ]);

        // Export battery state as GAction
        this.__state = new Gio.SimpleAction({
            name: 'battery',
            parameter_type: new GLib.VariantType('(bsii)'),
            state: this.state,
        });
        this.device.add_action(this.__state);

        // Local Battery (UPower)
        this._upower = null;
        this._sendStatisticsId = this.settings.connect(
            'changed::send-statistics',
            this._onSendStatisticsChanged.bind(this)
        );
        this._onSendStatisticsChanged(this.settings);
    }

    get charging() {
        if (this._charging === undefined)
            this._charging = false;

        return this._charging;
    }

    get icon_name() {
        let icon;

        if (this.level === -1)
            return 'battery-missing-symbolic';
        else if (this.level === 100)
            return 'battery-full-charged-symbolic';
        else if (this.level < 3)
            icon = 'battery-empty';
        else if (this.level < 10)
            icon = 'battery-caution';
        else if (this.level < 30)
            icon = 'battery-low';
        else if (this.level < 60)
            icon = 'battery-good';
        else if (this.level >= 60)
            icon = 'battery-full';

        if (this.charging)
            return `${icon}-charging-symbolic`;

        return `${icon}-symbolic`;
    }

    get level() {
        // This is what KDE Connect returns if the remote battery plugin is
        // disabled or still being loaded
        if (this._level === undefined)
            this._level = -1;

        return this._level;
    }

    get time() {
        if (this._time === undefined)
            this._time = 0;

        return this._time;
    }

    get state() {
        return new GLib.Variant(
            '(bsii)',
            [this.charging, this.icon_name, this.level, this.time]
        );
    }

    cacheLoaded() {
        this._initEstimate();
        this._sendState();
    }

    clearCache() {
        this._chargeState = [54, 0, -1];
        this._dischargeState = [864, 0, -1];
        this._thresholdLevel = 25;
        this._initEstimate();
    }

    connected() {
        super.connected();

        this._requestState();
        this._sendState();
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

    _onSendStatisticsChanged() {
        if (this.settings.get_boolean('send-statistics'))
            this._monitorState();
        else
            this._unmonitorState();
    }

    /**
     * Recalculate and update the estimated time remaining, but not the rate.
     */
    _initEstimate() {
        let rate, level;

        // elision of [rate, time, level]
        if (this.charging)
            [rate,, level] = this._chargeState;
        else
            [rate,, level] = this._dischargeState;

        if (!Number.isFinite(rate) || rate < 1)
            rate = this.charging ? 864 : 90;

        if (!Number.isFinite(level) || level < 0)
            level = this.level;

        // Update the time remaining
        if (rate && this.charging)
            this._time = Math.floor(rate * (100 - level));
        else if (rate && !this.charging)
            this._time = Math.floor(rate * level);

        this.__state.state = this.state;
    }

    /**
     * Recalculate the (dis)charge rate and update the estimated time remaining.
     */
    _updateEstimate() {
        let rate, time, level;
        let newTime = Math.floor(Date.now() / 1000);
        let newLevel = this.level;

        // Load the state; ensure we have sane values for calculation
        if (this.charging)
            [rate, time, level] = this._chargeState;
        else
            [rate, time, level] = this._dischargeState;

        if (!Number.isFinite(rate) || rate < 1)
            rate = this.charging ? 54 : 864;

        if (!Number.isFinite(time) || time <= 0)
            time = newTime;

        if (!Number.isFinite(level) || level < 0)
            level = newLevel;

        // Update the rate; use a weighted average to account for missed changes
        // NOTE: (rate = seconds/percent)
        let ldiff = this.charging ? newLevel - level : level - newLevel;
        let tdiff = newTime - time;
        let newRate = tdiff / ldiff;

        if (newRate && Number.isFinite(newRate))
            rate = Math.floor((rate * 0.4) + (newRate * 0.6));

        // Store the state for the next recalculation
        if (this.charging)
            this._chargeState = [rate, newTime, newLevel];
        else
            this._dischargeState = [rate, newTime, newLevel];

        // Update the time remaining
        if (rate && this.charging)
            this._time = Math.floor(rate * (100 - newLevel));
        else if (rate && !this.charging)
            this._time = Math.floor(rate * newLevel);

        this.__state.state = this.state;
    }

    /**
     * Notify the user the remote battery is full.
     */
    _fullBatteryNotification() {
        if (!this.settings.get_boolean('full-battery-notification'))
            return;

        // Offer the option to ring the device, if available
        let buttons = [];

        if (this.device.get_action_enabled('ring')) {
            buttons = [{
                label: _('Ring'),
                action: 'ring',
                parameter: null,
            }];
        }

        this.device.showNotification({
            id: 'battery|full',
            // TRANSLATORS: eg. Google Pixel: Battery is full
            title: _('%s: Battery is full').format(this.device.name),
            // TRANSLATORS: when the battery is fully charged
            body: _('Fully Charged'),
            icon: Gio.ThemedIcon.new('battery-full-charged-symbolic'),
            buttons: buttons,
        });
    }

    /**
     * Notify the user the remote battery is low.
     */
    _lowBatteryNotification() {
        if (!this.settings.get_boolean('low-battery-notification'))
            return;

        // Offer the option to ring the device, if available
        let buttons = [];

        if (this.device.get_action_enabled('ring')) {
            buttons = [{
                label: _('Ring'),
                action: 'ring',
                parameter: null,
            }];
        }

        this.device.showNotification({
            id: 'battery|low',
            // TRANSLATORS: eg. Google Pixel: Battery is low
            title: _('%s: Battery is low').format(this.device.name),
            // TRANSLATORS: eg. 15% remaining
            body: _('%d%% remaining').format(this.level),
            icon: Gio.ThemedIcon.new('battery-caution-symbolic'),
            buttons: buttons,
        });
    }

    /**
     * Handle a remote battery update.
     *
     * @param {Core.Packet} packet - A kdeconnect.battery packet
     */
    _receiveState(packet) {
        // Charging state changed
        this._charging = packet.body.isCharging;

        // Level changed
        if (this._level !== packet.body.currentCharge) {
            this._level = packet.body.currentCharge;

            // If the level is above the threshold hide the notification
            if (this._level > this._thresholdLevel)
                this.device.hideNotification('battery|low');

            // The level just changed to/from full
            if (this._level === 100)
                this._fullBatteryNotification();
            else
                this.device.hideNotification('battery|full');
        }

        // Device considers the level low
        if (packet.body.thresholdEvent > 0) {
            this._lowBatteryNotification();
            this._thresholdLevel = this.level;
        }

        this._updateEstimate();
    }

    /**
     * Request the remote battery's current state
     */
    _requestState() {
        this.device.sendPacket({
            type: 'kdeconnect.battery.request',
            body: {request: true},
        });
    }

    /**
     * Report the local battery's current state
     */
    _sendState() {
        if (this._upower === null || !this._upower.is_present)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.battery',
            body: {
                currentCharge: this._upower.level,
                isCharging: this._upower.charging,
                thresholdEvent: this._upower.threshold,
            },
        });
    }

    /*
     * UPower monitoring methods
     */
    _monitorState() {
        try {
            // Currently only true if the remote device is a desktop (rare)
            let incoming = this.device.settings.get_strv('incoming-capabilities');

            if (!incoming.includes('kdeconnect.battery'))
                return;

            this._upower = Components.acquire('upower');

            this._upowerId = this._upower.connect(
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
            if (this._upower === null)
                return;

            this._upower.disconnect(this._upowerId);
            this._upower = Components.release('upower');
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    destroy() {
        this.device.remove_action('battery');
        this.settings.disconnect(this._sendStatisticsId);
        this._unmonitorState();

        super.destroy();
    }
});

