'use strict';

const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;


var Battery = GObject.registerClass({
    GTypeName: 'GSConnectSystemBattery',
    Signals: {
        'changed': {flags: GObject.SignalFlags.RUN_FIRST}
    }
}, class Battery extends UPower.Device {

    _init() {
        super._init();

        // This will throw an exception
        this.set_object_path_sync(
            '/org/freedesktop/UPower/devices/DisplayDevice',
            null
        );
    }

    vfunc_notify(pspec) {
        try {
            switch (pspec.get_name()) {
                case 'percentage':
                case 'state':
                case 'warning-level':
                    this.emit('changed');
            }
        } catch (e) {
        }
    }

    get charging() {
        return (this.state !== UPower.DeviceState.DISCHARGING);
    }

    get level() {
        return this.percentage;
    }

    // TODO: reset on charging
    get threshold() {
        if (!this.charging && this.warning_level >= UPower.DeviceLevel.LOW) {
            return 1;
        } else {
            return 0;
        }
    }
});


/**
 * The service class for this component
 */
var Service = Battery;

