// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const {default: Manager} = await import(`file://${Config.PACKAGE_DATADIR}/service/manager.js`);


// TODO: * device management
//       * DBus
describe('Manager', function () {
    let manager;
    let testRig;

    beforeAll(function () {
        manager = new Manager({
            object_path: '/org/gnome/Shell/Extensions/GSConnect/Test',
        });

        testRig = new Utils.TestRig();

        spyOn(manager, '_loadDevices').and.callThrough();
        spyOn(manager, '_loadBackends');
    });

    afterAll(function () {
        manager.destroy();
        testRig.destroy();
    });

    it('sets defaults for required properties', function () {
        expect(manager.id).toBeTruthy();
        expect(manager.name).toBeTruthy();
    });

    it('can be started', function () {
        manager.start();

        // Disable auto-reconnect
        GLib.Source.remove(manager._reconnectId);
        manager._reconnectId = 0;

        expect(manager.active).toBeTrue();
        expect(manager._loadDevices).toHaveBeenCalled();
        expect(manager._loadBackends).toHaveBeenCalled();
    });

    it('can create devices for channels', function (done) {
        const {localService, remoteService} = testRig;

        // Managed service
        manager.backends.set('mock', localService);

        localService.__channelId = localService.connect('channel',
            manager._onChannel.bind(manager));

        localService.start();

        // Unmanaged service
        const id1 = remoteService.connect('channel', (service, channel) => {
            service.disconnect(id1);
            testRig.remoteChannel = channel;

            return true;
        });

        remoteService.start();

        //
        const id2 = manager.settings.connect('changed::devices', (settings) => {
            settings.disconnect(id2);
            expect(manager.devices).toHaveSize(1);

            done();
        });

        manager.identify(`mock://127.0.0.1:${remoteService.port}`);
    });

    it('can be stopped', function () {
        manager.stop();

        expect(manager.active).toBeFalse();
        expect(manager.devices).toHaveSize(0);
        expect(manager.backends).toHaveSize(0);
    });

    it('loads cached devices when started', function () {
        manager.start();

        expect(manager.devices).toHaveSize(1);

        manager.stop();
    });
});


describe('Manager rediscovery', function () {
    let manager;
    let backend;
    let device;

    beforeEach(function () {
        manager = new Manager({
            object_path: '/org/gnome/Shell/Extensions/GSConnect/RediscoveryTest',
        });
        manager.discoverable = true;
        backend = {broadcast: jasmine.createSpy('broadcast')};
        device = {
            connected: false,
            paired: true,
            settings: {get_string: () => 'mock://192.0.2.1:1716'},
        };
        manager.backends.set('mock', backend);
        manager.devices.set('paired-device', device);
    });

    afterEach(function () {
        manager.devices.clear();
        manager.backends.clear();
        manager.destroy();
    });

    it('retries cached addresses and periodically rediscovers missing devices', function () {
        for (let i = 0; i < 5; i++)
            manager._reconnect();

        expect(backend.broadcast.calls.count()).toBe(5);
        expect(backend.broadcast.calls.allArgs()).toEqual(
            Array.from({length: 5}, () => ['192.0.2.1:1716']));

        manager._reconnect();
        expect(backend.broadcast.calls.count()).toBe(7);
        expect(backend.broadcast.calls.mostRecent().args).toEqual([]);

        for (let i = 0; i < 6; i++)
            manager._reconnect();

        expect(backend.broadcast.calls.count()).toBe(14);
    });

    it('does not broadcast discovery when discovery is disabled', function () {
        manager.discoverable = false;
        for (let i = 0; i < 12; i++)
            manager._reconnect();

        expect(backend.broadcast.calls.allArgs()).toEqual(
            Array.from({length: 12}, () => ['192.0.2.1:1716']));
    });

    it('does not rediscover when all paired devices are connected', function () {
        device.connected = true;
        for (let i = 0; i < 12; i++)
            manager._reconnect();

        expect(backend.broadcast).not.toHaveBeenCalled();
    });

    it('does not rediscover when there are no devices', function () {
        manager.devices.clear();
        for (let i = 0; i < 12; i++)
            manager._reconnect();

        expect(backend.broadcast).not.toHaveBeenCalled();
    });

    it('resets the rediscovery interval after a device reconnects', function () {
        for (let i = 0; i < 5; i++)
            manager._reconnect();

        device.connected = true;
        manager._reconnect();
        device.connected = false;
        backend.broadcast.calls.reset();
        manager._reconnect();

        expect(backend.broadcast.calls.allArgs()).toEqual([['192.0.2.1:1716']]);
    });
});
