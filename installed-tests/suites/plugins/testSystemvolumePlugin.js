// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Utils = imports.fixtures.utils;


function handlePacket(packet) {
    switch (packet.type) {
        case 'kdeconnect.systemvolume':
            break;

        case 'kdeconnect.systemvolume.request':
            break;
    }
}


describe('The systemvolume plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.systemvolume',
                    'kdeconnect.systemvolume.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.systemvolume',
                    'kdeconnect.systemvolume.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.systemvolume',
                    'kdeconnect.systemvolume.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.systemvolume',
                    'kdeconnect.systemvolume.request',
                ],
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
        remoteDevice.handlePacket = handlePacket.bind(remoteDevice);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin)
            spyOn(localPlugin, 'handlePacket').and.callThrough();
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('systemvolume');

        expect(localPlugin).toBeDefined();
    });

    it('sends streams when connected', function () {
        spyOn(localPlugin, '_sendSinkList');

        testRig.setConnected(true);

        expect(localPlugin._sendSinkList).toHaveBeenCalled();
    });

    it('sends a list of streams when requested', async function () {
        spyOn(remoteDevice, 'handlePacket').and.callThrough();

        remoteDevice.sendPacket({
            type: 'kdeconnect.systemvolume.request',
            body: {
                requestSinks: true,
            },
        });

        await localPlugin.awaitPacket('kdeconnect.systemvolume.request', {
            requestSinks: true,
        });

        await remoteDevice.awaitPacket('kdeconnect.systemvolume');
    });

    it('handles volume level requests', async function () {
        remoteDevice.sendPacket({
            type: 'kdeconnect.systemvolume.request',
            body: {
                name: '0',
                volume: 2,
            },
        });

        await localPlugin.awaitPacket('kdeconnect.systemvolume.request', {
            name: '0',
            volume: 2,
        });

        expect(localPlugin._mixer.lookup_sink(0).volume).toBe(2);
    });

    it('handles mute requests', async function () {
        remoteDevice.sendPacket({
            type: 'kdeconnect.systemvolume.request',
            body: {
                name: '0',
                muted: true,
            },
        });

        await localPlugin.awaitPacket('kdeconnect.systemvolume.request', {
            name: '0',
            muted: true,
        });

        expect(localPlugin._mixer.lookup_sink(0).muted).toBeTrue();
    });
});

