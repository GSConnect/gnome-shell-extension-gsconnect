// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const {default: Device} = await import(`file://${Config.PACKAGE_DATADIR}/service/device.js`);


describe('A device constructed from a packet', function () {
    let device, identity;

    beforeAll(function () {
        identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: ['kdeconnect.ping'],
                outgoingCapabilities: ['kdeconnect.ping'],
            },
        });
        device = new Device(identity);
    });

    afterAll(function () {
        device.destroy();
    });

    it('initializes properties', function () {
        expect(device.id).toBe(identity.body.deviceId);
        expect(device.name).toBe(identity.body.deviceName);
        expect(device.type).toBe(identity.body.deviceType);

        // expect(device.contacts).toBeTruthy();
        expect(device.encryption_info).toBe('');
        expect(device.icon_name).toBeTruthy();

        expect(device.connected).toBeFalse();
        expect(device.paired).toBeFalse();

        expect(device.settings).toBeInstanceOf(Gio.Settings);
        expect(device.menu).toBeInstanceOf(Gio.Menu);
    });

    it('will not load plugins when unpaired', async function () {
        await device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will load plugins when paired', async function () {
        device._setPaired(true);
        expect(device.paired).toBeTrue();

        await device._loadPlugins();
        expect(device._plugins).toHaveSize(1);
    });

    it('unloads plugins when unpaired', function () {
        device.unpair();
        expect(device.paired).toBeFalse();
        expect(device._plugins).toHaveSize(0);
    });
});


describe('A device constructed from an ID', function () {
    let device, id;

    beforeAll(function () {
        id = Device.generateId();
        device = new Device({body: {deviceId: id}});
    });

    afterAll(function () {
        device.destroy();
    });

    it('initializes properties', function () {
        expect(device.id).toBe(id);
        expect(device.name).toBe('');
        expect(device.type).toBe('smartphone');

        // expect(device.contacts).toBeTruthy();
        expect(device.encryption_info).toBe('');
        expect(device.icon_name).toBeTruthy();

        expect(device.connected).toBeFalse();
        expect(device.paired).toBeFalse();

        expect(device.settings).toBeInstanceOf(Gio.Settings);
        expect(device.menu).toBeInstanceOf(Gio.Menu);
    });

    it('will not load plugins when unpaired', function () {
        device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will load plugins when paired', function () {
        device._setPaired(true);
        expect(device.paired).toBeTrue();

        device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will unload plugins when unpaired', function () {
        device.unpair();
        expect(device.paired).toBeFalse();
        expect(device._plugins).toHaveSize(0);
    });
});


describe('Device channel replacement', function () {
    it('resynchronizes plugins when a connected channel is replaced', function () {
        const device = new Device(Utils.generateIdentity());
        const first = {close: jasmine.createSpy('close')};
        const second = {close: jasmine.createSpy('close')};
        spyOn(device, '_handleIdentity');
        spyOn(device, '_readLoop');
        spyOn(device, '_triggerPlugins');

        try {
            device.setChannel(first);
            device._triggerPlugins.calls.reset();
            device.setChannel(second);

            expect(first.close).toHaveBeenCalledTimes(1);
            expect(device.connected).toBeTrue();
            expect(device._triggerPlugins).toHaveBeenCalledTimes(1);
        } finally {
            device.setChannel(null);
            device.destroy();
        }
    });

    it('stops an old reader without reading or dispatching on the new channel', async function () {
        let finishRead;
        const previous = {
            readPacket: jasmine.createSpy('old read').and.returnValue(
                new Promise(resolve => {
                    finishRead = resolve;
                })
            ),
        };
        const current = {
            readPacket: jasmine.createSpy('new read').and.callFake(() => {
                return Promise.reject(new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CANCELLED,
                    message: 'Test finished',
                }));
            }),
        };
        const device = {
            channel: previous,
            handlePacket: jasmine.createSpy('handlePacket'),
            setChannel: jasmine.createSpy('setChannel'),
        };

        const reading = Device.prototype._readLoop.call(device, previous);
        device.channel = current;
        finishRead({type: 'kdeconnect.clipboard', body: {content: 'old'}});
        await reading;

        expect(current.readPacket).not.toHaveBeenCalled();
        expect(device.handlePacket).not.toHaveBeenCalled();
        expect(device.setChannel).not.toHaveBeenCalled();
    });
});

