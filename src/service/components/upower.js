'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * The warning level of a battery.
 *
 * @readonly
 * @enum {number}
 */
const DeviceLevel = {
    UNKNOWN: 0,
    NONE: 1,
    DISCHARGING: 2,
    LOW: 3,
    CRITICAL: 4,
    ACTION: 5,
    NORMAL: 6,
    HIGH: 7,
    FULL: 8,
    LAST: 9,
};

/**
 * The device state.
 *
 * @readonly
 * @enum {number}
 */
const DeviceState = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
    LAST: 7,
};


/**
 * A class representing the system battery.
 */
var Battery = GObject.registerClass({
    GTypeName: 'GSConnectSystemBattery',
    Signals: {
        'changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
    Properties: {
        'charging': GObject.ParamSpec.boolean(
            'charging',
            'Charging',
            'The current charging state.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'level': GObject.ParamSpec.int(
            'level',
            'Level',
            'The current power level.',
            GObject.ParamFlags.READABLE,
            -1, 100,
            -1
        ),
        'threshold': GObject.ParamSpec.uint(
            'threshold',
            'Threshold',
            'The current threshold state.',
            GObject.ParamFlags.READABLE,
            0, 1,
            0
        ),
    },
}, class Battery extends GObject.Object {

    _init() {
        super._init();

        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._propertiesChangedId = 0;

        this._loadUPower();
    }

    async _loadUPower() {
        try {
            this._proxy = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SYSTEM,
                g_name: 'org.freedesktop.UPower',
                g_object_path: '/org/freedesktop/UPower/devices/DisplayDevice',
                g_interface_name: 'org.freedesktop.UPower.Device',
                g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            });

            await new Promise((resolve, reject) => {
                this._proxy.init_async(
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                    (proxy, res) => {
                        try {
                            resolve(proxy.init_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            this._propertiesChangedId = this._proxy.connect(
                'g-properties-changed',
                this._onPropertiesChanged.bind(this)
            );

            this._initProperties(this._proxy);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                const service = Gio.Application.get_default();

                if (service !== null)
                    service.notify_error(e);
                else
                    logError(e);
            }

            this._proxy = null;
        }
    }

    _initProperties(proxy) {
        if (proxy.g_name_owner === null)
            return;

        const percentage = proxy.get_cached_property('Percentage').unpack();
        const state = proxy.get_cached_property('State').unpack();
        const level = proxy.get_cached_property('WarningLevel').unpack();

        this._level = Math.floor(percentage);
        this._charging = (state !== DeviceState.DISCHARGING);
        this._threshold = (!this.charging && level >= DeviceLevel.LOW);

        this.emit('changed');
    }

    _onPropertiesChanged(proxy, changed, invalidated) {
        let emitChanged = false;
        const properties = changed.deepUnpack();

        if (properties.hasOwnProperty('Percentage')) {
            emitChanged = true;

            const value = proxy.get_cached_property('Percentage').unpack();
            this._level = Math.floor(value);
            this.notify('level');
        }

        if (properties.hasOwnProperty('State')) {
            emitChanged = true;

            const value = proxy.get_cached_property('State').unpack();
            this._charging = (value !== DeviceState.DISCHARGING);
            this.notify('charging');
        }

        if (properties.hasOwnProperty('WarningLevel')) {
            emitChanged = true;

            const value = proxy.get_cached_property('WarningLevel').unpack();
            this._threshold = (!this.charging && value >= DeviceLevel.LOW);
            this.notify('threshold');
        }

        if (emitChanged)
            this.emit('changed');
    }

    get charging() {
        if (this._charging === undefined)
            this._charging = false;

        return this._charging;
    }

    get is_present() {
        return (this._proxy && this._proxy.g_name_owner);
    }

    get level() {
        if (this._level === undefined)
            this._level = -1;

        return this._level;
    }

    get threshold() {
        if (this._threshold === undefined)
            this._threshold = 0;

        return this._threshold;
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();

        if (this._proxy && this._propertiesChangedId > 0) {
            this._proxy.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }
    }
});


/**
 * The service class for this component
 */
var Component = Battery;

