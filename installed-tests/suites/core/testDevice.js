// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const {default: Device} = await import(`file://${Config.PACKAGE_DATADIR}/service/device.js`);


/*
 * A channel that records the types of the packets it writes, or doesn't
 * finish writing them until closed if blocked, and reads packets passed to
 * receive()
 */
const TestChannel = GObject.registerClass({
    GTypeName: 'GSConnectTestDeviceChannel',
}, class TestChannel extends Core.Channel {
    _init(identity, blocked = false) {
        super._init();

        this.identity = identity;
        this.written = [];
        this.output_stream = Gio.MemoryOutputStream.new_resizable();
        this.output_stream.write_all_async = (data, priority, cancellable) => {
            if (!blocked) {
                this.written.push(JSON.parse(data).type);
                return Promise.resolve([true, data.length]);
            }

            return new Promise((resolve, reject) => {
                cancellable.connect(() => reject(new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CANCELLED,
                    message: 'Cancelled',
                })));
            });
        };
    }

    get address() {
        return 'test://';
    }

    readPacket() {
        this.reads = (this.reads ?? 0) + 1;

        return new Promise(resolve => (this.receive = resolve));
    }

    close() {
        this._closed = true;
        this.cancellable.cancel();
    }
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

    it('cancels transfers when unpaired', function () {
        device._setPaired(true);
        const transfer = device.createTransfer();
        spyOn(transfer, 'cancel').and.callThrough();

        device.unpair();

        expect(transfer.cancel).toHaveBeenCalled();
        expect(device._transfers).toHaveSize(0);
        expect(device.paired).toBeFalse();
        expect(device.settings.get_boolean('paired')).toBeFalse();
    });
});


describe('A connected device', function () {
    let device, written;

    beforeAll(function () {
        device = new Device(Utils.generateIdentity());
        device._setPaired(true);

        // A channel that is still writing the packets it was given
        written = [];
        device._channel = {
            sendPacket(packet) {
                written.push(packet.type);
                return new Promise(() => {});
            },
        };
        device._connected = true;
    });

    afterAll(function () {
        device._channel = null;
        device._connected = false;
        device.destroy();
    });

    it('passes packets to the channel in order with its own', function () {
        device.sendPacket({type: 'kdeconnect.first', body: {}});
        device.sendPacket({type: 'kdeconnect.second', body: {}});

        // Like the request of an upload, sent by the channel itself
        device.channel.sendPacket({type: 'kdeconnect.request'});

        expect(written).toEqual([
            'kdeconnect.first',
            'kdeconnect.second',
            'kdeconnect.request',
        ]);
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


describe('A device whose channel is replaced', function () {
    let device, identity;

    beforeAll(function () {
        identity = Utils.generateIdentity();
        device = new Device(identity);
        device._setPaired(true);
    });

    afterAll(function () {
        device.setChannel(null);
        device.destroy();
    });

    it('writes packets that were waiting to the new channel', async function () {
        // The device stops reading, so a packet is never written
        device.setChannel(new TestChannel(identity, true));
        device.sendPacket({type: 'kdeconnect.stuck', body: {}});
        device.sendPacket({type: 'kdeconnect.waiting', body: {}});

        // The request of a transfer belongs to the replaced channel
        const request = device.channel.sendPacket(new Core.Packet({
            type: 'kdeconnect.request',
            body: {},
            payloadSize: 1,
            payloadTransferInfo: {port: 1739},
        }));

        const replacement = new TestChannel(identity);
        device.setChannel(replacement);
        device.sendPacket({type: 'kdeconnect.later', body: {}});

        await expectAsync(request).toBeRejected();
        await Utils.waitFor(() => replacement.written.length === 2);
        expect(replacement.written).toEqual([
            'kdeconnect.waiting',
            'kdeconnect.later',
        ]);
    });

    it('only reads from the new channel once', async function () {
        const replaced = new TestChannel(identity);
        device.setChannel(replaced);

        const replacement = new TestChannel(identity);
        device.setChannel(replacement);

        // A packet read from the replaced channel as it's replaced
        replaced.receive(new Core.Packet({type: 'kdeconnect.late', body: {}}));
        await Promise.idle();

        expect(replacement.reads).toBe(1);
    });
});
