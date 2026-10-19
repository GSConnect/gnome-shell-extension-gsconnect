// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


const NotificationsIface = `
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg type="s" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/>
      <arg type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification">
      <arg type="u" direction="in"/>
    </method>
    <signal name="NotificationClosed">
      <arg type="u"/>
      <arg type="u"/>
    </signal>
    <signal name="ActionInvoked">
      <arg type="u"/>
      <arg type="s"/>
    </signal>
  </interface>
</node>`;


/**
 * A minimal notification server, recording what the plugin sends it.
 */
class MockNotificationServer {
    constructor() {
        this.notified = [];
        this.closed = [];
        this._nextId = 1;

        this._exported = Gio.DBusExportedObject.wrapJSObject(NotificationsIface, this);
        this._exported.export(Gio.DBus.session, '/org/freedesktop/Notifications');
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session,
            'org.freedesktop.Notifications',
            Gio.BusNameOwnerFlags.NONE,
            null,
            null
        );
    }

    Notify(appName, replacesId, icon, summary, body, actions, hints, timeout) {
        const id = this._nextId++;
        this.notified.push({id, summary, body, actions, hints});

        return id;
    }

    CloseNotification(id) {
        this.closed.push(id);
    }

    // Simulate the user dismissing the notification (2) or using a button
    dismiss(id) {
        this._exported.emit_signal('NotificationClosed', new GLib.Variant('(uu)', [id, 2]));
    }

    invoke(id, action) {
        this._exported.emit_signal('ActionInvoked', new GLib.Variant('(us)', [id, action]));
    }

    destroy() {
        Gio.bus_unown_name(this._ownerId);
        this._exported.unexport();
    }
}


/**
 * Iterate the main loop until a condition is true, or fail after a few seconds.
 *
 * @param {() => boolean} condition - A function returning a boolean
 * @returns {Promise} A promise for the condition becoming true
 */
function waitFor(condition) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (condition()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }

            if (++attempts > 250) {
                reject(new Error('Timed out waiting for condition'));
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    });
}


describe('The findmyphone plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: ['kdeconnect.findmyphone.request'],
                outgoingCapabilities: ['kdeconnect.findmyphone.request'],
            },
            remoteDevice: {
                incomingCapabilities: ['kdeconnect.findmyphone.request'],
                outgoingCapabilities: ['kdeconnect.findmyphone.request'],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin) {
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, '_handleRequest');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('findmyphone');
        remotePlugin = testRig.remoteDevice._plugins.get('findmyphone');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('ring')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('ring')).toBeTrue();
    });

    it('can send and receive ring requests', async function () {
        localPlugin.ring();

        await remotePlugin.awaitPacket('kdeconnect.findmyphone.request');
        expect(remotePlugin._handleRequest).toHaveBeenCalled();
    });

    describe('when ringing', function () {
        let server;

        beforeEach(function () {
            remotePlugin._handleRequest.and.callThrough();
        });

        afterEach(function () {
            remotePlugin.stopRinging();
            server?.destroy();
            server = null;
        });

        it('stops ringing if the notification can not be shown', async function () {
            // No notification server is running; the error would be fatal
            spyOn(globalThis, 'logError');

            remotePlugin._handleRequest();
            expect(remotePlugin._ringingCancellable).not.toBeNull();

            await waitFor(() => remotePlugin._ringingCancellable === null);
            expect(globalThis.logError).toHaveBeenCalled();
        });

        describe('with a notification server', function () {
            let notification;

            beforeEach(async function () {
                server = new MockNotificationServer();

                remotePlugin._handleRequest();
                await waitFor(() => server.notified.length === 1);
                await waitFor(() => remotePlugin._notificationId !== 0);

                notification = server.notified[0];
            });

            it('shows an urgent notification with a button to silence', function () {
                expect(remotePlugin._ringingCancellable).not.toBeNull();
                expect(notification.summary).toBe(remotePlugin.device.name);
                expect(notification.actions).toContain('silence');
                expect(notification.hints.urgency.unpack()).toBe(2);
            });

            it('stops ringing when the notification is dismissed', async function () {
                server.dismiss(notification.id);

                await waitFor(() => remotePlugin._ringingCancellable === null);
            });

            it('stops ringing when the button is used', async function () {
                server.invoke(notification.id, 'silence');

                await waitFor(() => remotePlugin._ringingCancellable === null);
            });

            it('keeps ringing when other notifications are closed', async function () {
                server.dismiss(notification.id + 100);
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));

                expect(remotePlugin._ringingCancellable).not.toBeNull();
            });

            it('stops ringing and withdraws the notification on a second request', async function () {
                remotePlugin._handleRequest();

                expect(remotePlugin._ringingCancellable).toBeNull();
                await waitFor(() => server.closed.includes(notification.id));
            });

            it('stops ringing when the device disconnects', async function () {
                remotePlugin.disconnected();

                expect(remotePlugin._ringingCancellable).toBeNull();
                await waitFor(() => server.closed.includes(notification.id));

                // The test rig's connection state is expected by what follows
                testRig.setConnected(true);
            });
        });
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('ring')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('ring')).toBeFalse();
    });
});

