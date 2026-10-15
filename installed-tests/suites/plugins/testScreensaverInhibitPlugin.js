// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';


describe('The screensaver_inhibit plugin', function () {
    let testRig;
    let device, plugin, service;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [],
                outgoingCapabilities: [],
            },
            remoteDevice: {
                incomingCapabilities: [],
                outgoingCapabilities: [],
            },
        });
        testRig.setPaired(true);

        device = testRig.localDevice;
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        service = jasmine.createSpyObj('Service', ['inhibit', 'uninhibit']);
        service.inhibit.and.returnValue(42);
        spyOnProperty(device, 'service').and.returnValue(service);
    });

    it('is supported without any packets, but disabled by default', function () {
        expect(device.settings.get_strv('supported-plugins'))
            .toContain('screensaver_inhibit');
        expect(device.settings.get_strv('disabled-plugins'))
            .toContain('screensaver_inhibit');
    });

    it('stays enabled once the user enables it', function () {
        device.settings.set_strv('disabled-plugins', []);
        device._handleIdentity(testRig.localChannel.identity);

        expect(device.settings.get_strv('disabled-plugins'))
            .not.toContain('screensaver_inhibit');
    });

    it('keeps the session from going idle while connected', async function () {
        await testRig.loadPlugins();
        plugin = device._plugins.get('screensaver_inhibit');
        expect(plugin).toBeDefined();

        await testRig.setConnected(true);

        expect(service.inhibit).toHaveBeenCalledTimes(1);
        expect(service.inhibit.calls.argsFor(0)[2]).toContain(device.name);
    });

    it('lets the session go idle when disconnected', async function () {
        plugin._cookie = 42;
        await testRig.setConnected(false);

        expect(service.uninhibit).toHaveBeenCalledWith(42);
        expect(plugin._cookie).toBe(0);
    });
});
