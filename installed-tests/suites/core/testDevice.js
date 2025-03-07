'use strict';

const {Gio, GLib} = imports.gi;

const Utils = imports.fixtures.utils;

const Device = imports.service.device;


describe('A device constructed from a packet', function () {
    let device, identity;

    beforeAll(function () {
        identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: ['kdeconnect.ping'],
                outgoingCapabilities: ['kdeconnect.ping'],
            },
        });
        device = new Device.Device(identity);
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
        id = Device.Device.generateId();
        device = new Device.Device({body: {deviceId: id}});
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

