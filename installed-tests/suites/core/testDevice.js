// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const {
    default: Device,
    _packetForDebug,
} = await import(`file://${Config.PACKAGE_DATADIR}/service/device.js`);


describe('Packet debug logging', function () {
    it('redacts virtual-monitor connection credentials without mutation', function () {
        const packet = {
            id: 1,
            type: 'kdeconnect.virtualmonitor.request',
            body: {
                action: 'connect',
                sessionId: 'session-1',
                username: 'gsconnect',
                password: 'one-time-secret',
                certificateFingerprint: 'certificate-secret',
            },
        };
        const logged = _packetForDebug(packet);

        expect(logged.body.password).toBe('[redacted]');
        expect(logged.body.certificateFingerprint).toBe('[redacted]');
        expect(logged.body.sessionId).toBe('session-1');
        expect(packet.body.password).toBe('one-time-secret');
        expect(packet.body.certificateFingerprint).toBe('certificate-secret');
    });

    it('redacts arbitrary virtual-monitor diagnostics', function () {
        const packet = {
            type: 'kdeconnect.virtualmonitor',
            body: {
                action: 'diagnostic',
                entries: ['one-time-secret', '/home/user/private-path'],
            },
        };

        expect(_packetForDebug(packet).body.entries).toBe('[redacted]');
        expect(packet.body.entries).toHaveSize(2);
    });

    it('redacts credentials even for an unknown action', function () {
        const packet = {
            type: 'kdeconnect.virtualmonitor.request',
            body: {
                action: 'unexpected',
                password: 'must-not-reach-the-journal',
            },
        };

        expect(_packetForDebug(packet).body.password).toBe('[redacted]');
        expect(packet.body.password).toBe('must-not-reach-the-journal');
    });
});


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
