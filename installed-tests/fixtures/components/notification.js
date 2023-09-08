// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib, GObject} = imports.gi; //todo port import


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
        const variant = GLib.Variant.full_pack(notif);
        this.emit('notification-added', variant);
    }
});

