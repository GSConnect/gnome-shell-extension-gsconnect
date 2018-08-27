'use strict';

const GObject = imports.gi.GObject;
const UPower = imports.gi.UPowerGlib;


var Metadata = {
    summary: _('UPower'),
    description: _('Power statistics and monitoring')
};


var Component = GObject.registerClass({
    GTypeName: 'GSConnectUPowerComponent',
    Signals: {
        'changed': { flags: GObject.SignalFlags.RUN_FIRST }
    }
}, class UPowerComponent extends UPower.Device {

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
                default:
                    return;
            }
        } catch (e) {
        }
    }
});

