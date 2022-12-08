// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib} = imports.gi;

const Utils = imports.fixtures.utils;


const Notifications = {
    withoutIcon: {
        appName: 'Application',
        id: 'test-notification',
        title: 'Notification Title',
        text: 'Notification Body',
        ticker: 'Notification Title - Notification Body',
        time: '1599103247103',
        isClearable: true,
    },
    withIcon: {
        appName: 'Application',
        id: 'test-notification',
        title: 'Notification Title',
        text: 'Notification Body',
        ticker: 'Notification Title - Notification Body',
        time: '1599103247103',
        isClearable: true,
        icon: new Gio.FileIcon({
            file: Gio.File.new_for_uri(Utils.getDataUri('album.png')),
        }),
    },
    repliable: {
        appName: 'Application',
        id: 'test-notification',
        title: 'Notification Title',
        text: 'Notification Body',
        ticker: 'Notification Title - Notification Body',
        time: '1599103247103',
        isClearable: true,
        requestReplyId: GLib.uuid_string_random(),
    },
    actionable: {
        appName: 'Application',
        id: 'test-notification',
        title: 'Notification Title',
        text: 'Notification Body',
        ticker: 'Notification Title - Notification Body',
        time: '1599103247103',
        isClearable: true,
        actions: ['One', 'Two', 'Three'],
    },
};


describe('The notification plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.action',
                    'kdeconnect.notification.reply',
                    'kdeconnect.notification.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.action',
                    'kdeconnect.notification.reply',
                    'kdeconnect.notification.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.action',
                    'kdeconnect.notification.reply',
                    'kdeconnect.notification.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.action',
                    'kdeconnect.notification.reply',
                    'kdeconnect.notification.request',
                ],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin.device, 'hideNotification');
            spyOn(localPlugin.device, 'showNotification');

            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin.device, 'hideNotification');
            spyOn(remotePlugin.device, 'showNotification');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('notification');
        remotePlugin = testRig.remoteDevice._plugins.get('notification');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeTrue();
    });

    it('request notifications when connected', async function () {
        spyOn(remotePlugin, '_handleNotificationRequest');

        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.notification.request', {
            request: true,
        });

        expect(remotePlugin._handleNotificationRequest).toHaveBeenCalled();
    });

    describe('can send and receive notifications', function () {
        it('without icons', async function () {
            localPlugin._listener.fakeNotification(Notifications.withoutIcon);

            await remotePlugin.awaitPacket('kdeconnect.notification',
                Notifications.withoutIcon);

            expect(remotePlugin.device.showNotification).toHaveBeenCalled();
        });

        it('with icons', async function () {
            localPlugin._listener.fakeNotification(Notifications.withIcon);

            await remotePlugin.awaitPacket('kdeconnect.notification',
                Notifications.withoutIcon);

            // while (!remotePlugin.device.showNotification.calls.any())
            //     await Promise.idle();

            // expect(remotePlugin.device.showNotification).toHaveBeenCalled();
        });
    });

    describe('ignores notifications', function () {
        beforeEach(function () {
            spyOn(localPlugin.device, 'sendPacket').and.callThrough();
        });

        it('when sending is not allowed', function () {
            localPlugin.settings.set_boolean('send-notifications', false);

            localPlugin._listener.fakeNotification(Notifications.withoutIcon);

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
            localPlugin.settings.set_boolean('send-notifications', true);
        });

        it('when sending in an active session is not allowed', function () {
            localPlugin.settings.set_boolean('send-active', false);

            localPlugin._listener.fakeNotification(Notifications.withoutIcon);

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
            localPlugin.settings.set_boolean('send-active', true);

        });

        it('when sending for the application is not allowed', function () {
            const applications = localPlugin.settings.get_string('applications');
            const disabled = JSON.parse(applications);
            disabled['Application'].enabled = false;
            localPlugin.settings.set_string('applications',
                JSON.stringify(disabled));

            localPlugin._listener.fakeNotification(Notifications.withoutIcon);

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
            localPlugin.settings.set_string('applications', applications);
        });
    });

    it('can handle repliable notifications', async function () {
        // Ensure the packet sends...
        localPlugin._listener.fakeNotification(Notifications.repliable);

        await remotePlugin.awaitPacket('kdeconnect.notification',
            Notifications.repliable);

        expect(remotePlugin.device.showNotification).toHaveBeenCalled();

        // ...then check the notification was properly formed
        const invocation = remotePlugin.device.showNotification.calls.first();
        const notif = invocation.args[0];

        expect(notif.action.name).toBe('replyNotification');
    });

    it('can send replies for repliable notifications', function () {
        spyOn(localPlugin.device, 'sendPacket');

        const uuid = GLib.uuid_string_random();
        const message = 'message';

        localPlugin.replyNotification(uuid, message, {});
        expect(localPlugin.device.sendPacket).toHaveBeenCalled();
    });

    it('can handle notifications with actions', async function () {
        // Ensure the packet sends...
        localPlugin._listener.fakeNotification(Notifications.actionable);

        await remotePlugin.awaitPacket('kdeconnect.notification',
            Notifications.actionable);

        expect(remotePlugin.device.showNotification).toHaveBeenCalled();

        // ...then check the notification was properly formed
        const invocation = remotePlugin.device.showNotification.calls.first();
        const notif = invocation.args[0];

        expect(notif.buttons[0].label).toBe('One');
        expect(notif.buttons[1].label).toBe('Two');
        expect(notif.buttons[2].label).toBe('Three');
    });

    it('can activate actions for notifications', function () {
        spyOn(localPlugin.device, 'sendPacket');

        const id = GLib.uuid_string_random();
        const action = 'Action';

        localPlugin.activateNotification(id, action);
        expect(localPlugin.device.sendPacket).toHaveBeenCalled();
    });

    it('can withdraw local notifications', async function () {
        const id = GLib.uuid_string_random();

        localPlugin.withdrawNotification(id);

        await remotePlugin.awaitPacket('kdeconnect.notification', {
            id: id,
            isCancel: true,
        });

        expect(remotePlugin.device.hideNotification).toHaveBeenCalledWith(id);
    });

    it('can close remote notifications', async function () {
        spyOn(remotePlugin, '_handleNotificationRequest');

        const id = GLib.uuid_string_random();
        localPlugin.closeNotification(id);

        await remotePlugin.awaitPacket('kdeconnect.notification.request', {
            cancel: id,
        });

        expect(remotePlugin._handleNotificationRequest).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeFalse();

        for (const action in remotePlugin._meta.actions)
            expect(remotePlugin.device.get_action_enabled(action)).toBeFalse();
    });
});

