// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Utils = imports.fixtures.utils; //todo port import


describe('The findmyphone plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

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

    it('stops ringing on the second request', async function () {
        localPlugin.ring();

        await remotePlugin.awaitPacket('kdeconnect.findmyphone.request');
        expect(remotePlugin._handleRequest).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('ring')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('ring')).toBeFalse();
    });
});

