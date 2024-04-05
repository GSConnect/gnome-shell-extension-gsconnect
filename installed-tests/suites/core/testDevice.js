// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
        expect(device.encryption_info).toBeTruthy();
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
        id = GLib.uuid_string_random();
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
        expect(device.encryption_info).toBeTruthy();
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

