// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {GLib} = imports.gi; //todo port import

const Utils = imports.fixtures.utils; //todo port import

const {Manager} = imports.service.manager; //todo port import


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

