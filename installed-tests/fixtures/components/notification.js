'use strict';

const {Gio, GLib, GObject} = imports.gi;


var Component = GObject.registerClass({
    GTypeName: 'GSConnectMockNotificationListener',
    Signals: {
        'notification-added': {
            flags: GObject.SignalFlags.RUN_LAST,
            param_types: [GLib.Variant.$gtype],
        },
    },
}, class MockListener extends GObject.Object {

    fakeNotification(notif) {
        let variant = GLib.Variant.full_pack(notif);
        this.emit('notification-added', variant);
    }
});

