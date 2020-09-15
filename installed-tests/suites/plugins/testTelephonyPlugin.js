'use strict';

const Utils = imports.fixtures.utils;


const Packets = {
    ringing: {
        type: 'kdeconnect.telephony',
        body: {
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
    ringingCancel: {
        type: 'kdeconnect.telephony',
        body: {
            isCancel: true,
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
    talking: {
        type: 'kdeconnect.telephony',
        body: {
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'talking',
        },
    },
    talkingCancel: {
        type: 'kdeconnect.telephony',
        body: {
            isCancel: true,
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
};


describe('The telephony plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.telephony.request',
                    'kdeconnect.telephony.request_mute',
                ],
                outgoingCapabilities: [
                    'kdeconnect.telephony',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.telephony.request',
                    'kdeconnect.telephony.request_mute',
                ],
                outgoingCapabilities: [
                    'kdeconnect.telephony',
                ],
            },
        });
        testRig.setPaired(true);
        testRig.setConnected(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin.device, 'showNotification');
            spyOn(localPlugin.device, 'hideNotification');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('telephony');
        remotePlugin = testRig.remoteDevice._plugins.get('telephony');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();

        // Unset the event triggers for initial tests
        localPlugin.settings.set_string('ringing-volume', 'nothing');
        localPlugin.settings.set_boolean('ringing-pause', false);

        localPlugin.settings.set_string('talking-volume', 'nothing');
        localPlugin.settings.set_boolean('talking-microphone', false);
        localPlugin.settings.set_boolean('talking-pause', false);
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('muteCall')).toBeTrue();
    });

    it('shows a notification when the phone is ringing', async function () {
        remotePlugin.device.sendPacket(Packets.ringing);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringing.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('hides the notification if the phone stops ringing', async function () {
        remotePlugin.device.sendPacket(Packets.ringingCancel);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringingCancel.body);

        expect(localPlugin.device.hideNotification).toHaveBeenCalled();
    });

    it('shows a notification when the phone is answered', async function () {
        remotePlugin.device.sendPacket(Packets.talking);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.talking.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('hides the notification when the call ends', async function () {
        remotePlugin.device.sendPacket(Packets.talkingCancel);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.talkingCancel.body);

        expect(localPlugin.device.hideNotification).toHaveBeenCalled();
    });

    describe('can lower and restore the volume', function () {
        let localMixer;

        beforeEach(function () {
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'lowerVolume');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'lower');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.lowerVolume).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_string('talking-volume', 'lower');

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.lowerVolume).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('can mute and unmute the volume', function () {
        let localMixer;

        beforeEach(function () {
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'muteVolume');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'mute');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.muteVolume).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_string('talking-volume', 'mute');

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteVolume).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('can mute and unmute the microphone', function () {
        let localMixer;

        beforeEach(function () {
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'muteMicrophone');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_boolean('talking-microphone', true);

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteMicrophone).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('can pause and unpause media', function () {
        let localMedia;

        beforeEach(function () {
            localMedia = localPlugin._mpris;
            spyOn(localMedia, 'pauseAll');
            spyOn(localMedia, 'unpauseAll');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_boolean('ringing-pause', true);

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMedia.pauseAll).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMedia.unpauseAll).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_boolean('talking-pause', true);

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMedia.pauseAll).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMedia.unpauseAll).toHaveBeenCalled();
        });
    });

    it('disabled its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('muteCall')).toBeFalse();
    });
});

