'use strict';

const Utils = imports.fixtures.utils;


const Packets = {
    goodBattery: {
        type: 'kdeconnect.battery',
        body: {
            currentCharge: 50,
            isCharging: false,
            thresholdEvent: 0,
        },
    },
    lowBattery: {
        type: 'kdeconnect.battery',
        body: {
            currentCharge: 15,
            isCharging: false,
            thresholdEvent: 1,
        },
    },
    sixtyBattery: {
        type: 'kdeconnect.battery',
        body: {
            currentCharge: 60,
            isCharging: true,
            thresholdEvent: 0,
        },
    },
    eightyBattery: {
        type: 'kdeconnect.battery',
        body: {
            currentCharge: 80,
            isCharging: true,
            thresholdEvent: 0,
        },
    },
    fullBattery: {
        type: 'kdeconnect.battery',
        body: {
            currentCharge: 100,
            isCharging: true,
            thresholdEvent: 0,
        },
    },
};


describe('The battery plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.battery',
                    'kdeconnect.battery.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.battery',
                    'kdeconnect.battery.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.battery',
                    'kdeconnect.battery.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.battery',
                    'kdeconnect.battery.request',
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
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, '_receiveState').and.callThrough();
            spyOn(remotePlugin, '_requestState').and.callThrough();
            spyOn(remotePlugin, '_sendState').and.callThrough();

            spyOn(remotePlugin.device, 'showNotification');
            spyOn(remotePlugin.device, 'hideNotification');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('battery');
        remotePlugin = testRig.remoteDevice._plugins.get('battery');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('sends and requests state updates when connected', async function () {
        testRig.setConnected(true);

        await remotePlugin.awaitPacket('kdeconnect.battery.request');
        expect(remotePlugin._requestState).toHaveBeenCalled();
        expect(remotePlugin._sendState).toHaveBeenCalled();
    });

    it('can receive state updates', async function () {
        localPlugin.device.sendPacket(Packets.goodBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.goodBattery.body);
        expect(remotePlugin._receiveState).toHaveBeenCalled();
    });

    it('updates properties', function () {
        expect(remotePlugin.charging).toBeFalse();
        expect(remotePlugin.icon_name).toBe('battery-good-symbolic');
        expect(remotePlugin.level).toBe(50);
        expect(remotePlugin.time).toBeGreaterThan(0);
    });

    it('updates the GAction state', function () {
        const batteryAction = remotePlugin.device.lookup_action('battery');
        const [charging, icon, level, time] = batteryAction.state.deepUnpack();

        expect(charging).toBeFalse();
        expect(icon).toBe('battery-good-symbolic');
        expect(level).toBe(50);
        expect(time).toBeGreaterThan(0);
    });

    it('notifies when the battery is low', async function () {
        localPlugin.device.sendPacket(Packets.lowBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.lowBattery.body);
        expect(remotePlugin.device.showNotification).toHaveBeenCalled();
    });

    it('withdraws low battery notifications', async function () {
        localPlugin.device.sendPacket(Packets.goodBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.goodBattery.body);
        expect(remotePlugin.device.hideNotification).toHaveBeenCalled();
    });
    
    it('notifies when the battery is at 80%', async function () {
        localPlugin.device.sendPacket(Packets.eightyBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.eightyBattery.body);
        expect(remotePlugin.device.showNotification).toHaveBeenCalled();
    });

    it('withdraws 80% battery notifications', async function () {
        localPlugin.device.sendPacket(Packets.goodBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.goodBattery.body);
        expect(remotePlugin.device.hideNotification).toHaveBeenCalled();
    });

    it('notifies when the battery is full', async function () {
        remotePlugin.settings.set_boolean('full-battery-notification', true);
        localPlugin.device.sendPacket(Packets.fullBattery,
            Packets.fullBattery.body);

        await remotePlugin.awaitPacket('kdeconnect.battery');
        expect(remotePlugin.device.showNotification).toHaveBeenCalled();
    });

    it('withdraws full battery notifications', async function () {
        localPlugin.device.sendPacket(Packets.goodBattery);

        await remotePlugin.awaitPacket('kdeconnect.battery',
            Packets.goodBattery.body);
        expect(remotePlugin.device.hideNotification).toHaveBeenCalled();
    });

    describe('sends local statistics', function () {
        it('when enabled', async function () {
            localPlugin.settings.set_boolean('send-statistics', true);

            await remotePlugin.awaitPacket('kdeconnect.battery');
        });

        it('when they change', async function () {
            localPlugin._upower.update({
                charging: true,
                level: 50,
                threshold: 0,
            });

            await remotePlugin.awaitPacket('kdeconnect.battery', {
                currentCharge: 50,
                isCharging: true,
                thresholdEvent: 0,
            });
        });

        it('only if available', function () {
            spyOn(localPlugin.device, 'sendPacket');

            localPlugin._upower.update({
                is_present: false,
            });

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
        });
    });
});

