// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';


describe('The connectivity report plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.connectivity_report',
                ],
                outgoingCapabilities: [
                    'kdeconnect.connectivity_report.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.connectivity_report',
                ],
                outgoingCapabilities: [
                    'kdeconnect.connectivity_report.request',
                ],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin)
            spyOn(remotePlugin, '_requestState').and.callThrough();
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('connectivity_report');
        remotePlugin = testRig.remoteDevice._plugins.get('connectivity_report');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('requests the state update when connected', async function () {
        testRig.setConnected(true);

        await remotePlugin.awaitPacket(
            'kdeconnect.connectivity_report.request');
        expect(remotePlugin._requestState).toHaveBeenCalled();
    });

    it('can receive state updates', async function () {
        localPlugin.device.sendPacket({
            type: 'kdeconnect.connectivity_report',
            body: {
                signalStrengths: {
                    0: {
                        networkType: 'LTE',
                        signalStrength: 3,
                    },
                },
            },
        });

        await remotePlugin.awaitPacket('kdeconnect.connectivity_report');
        expect(remotePlugin.signal_strength).toBe(3);
        expect(remotePlugin.network_type).toBe('LTE');
    });

    it('updates the GAction state', function () {
        const reportAction =
            remotePlugin.device.lookup_action('connectivityReport');
        const [networkType, iconName, strength] =
            reportAction.state.deepUnpack();

        expect(networkType).toBe('LTE');
        expect(iconName).toContain('network-cellular-4g');
        expect(strength).toBe(3);
    });

    describe('when the device cannot handle connectivity report requests', function () {
        let requestlessRig, requestlessPlugin;

        beforeAll(async function () {
            await Utils.mockComponents();

            requestlessRig = new Utils.TestRig();
            await requestlessRig.prepare({
                remoteDevice: {
                    incomingCapabilities: [
                        'kdeconnect.connectivity_report',
                        // NOTE: 'kdeconnect.connectivity_report.request'
                        // intentionally omitted, matching devices that only
                        // push updates
                    ],
                    outgoingCapabilities: [
                        'kdeconnect.connectivity_report',
                    ],
                },
            });
            requestlessRig.setPaired(true);

            await requestlessRig.loadPlugins();
            requestlessPlugin =
                requestlessRig.remoteDevice._plugins.get(
                    'connectivity_report');
        });

        afterAll(function () {
            requestlessRig.destroy();
        });

        it('does not send a request when connected', async function () {
            spyOn(requestlessPlugin.device, 'sendPacket');

            requestlessRig.setConnected(true);
            await Promise.idle();

            const sentTypes = requestlessPlugin.device.sendPacket
                .calls.allArgs()
                .map(args => args[0].type);

            expect(sentTypes)
                .not.toContain('kdeconnect.connectivity_report.request');
        });
    });
});
