// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib} = imports.gi; //todo port import

const Utils = imports.fixtures.utils; //todo port import

const Core = imports.service.core; //todo port import


/*
 * Test Packets
 */
const ObjectPacket = {
    id: Date.now(),
    type: 'kdeconnect.foo',
    body: {
        bar: 'baz',
    },
};

const PayloadPacket = {
    id: Date.now(),
    type: 'kdeconnect.foo',
    body: {
        bar: 'baz',
    },
    payloadSize: Math.random() * 100,
    payloadTransferInfo: {port: 1739},
};

const DataPacket = `{
    "id": 1234,
    "type": "kdeconnect.foo",
    "body": {
        "bar": "baz"
    }
}`;


describe('A packet', function () {
    let dataData, dataPacket;
    let objectData, objectPacket;
    let payloadData, payloadPacket;

    it('can be deserialized from an object', function () {
        objectPacket = new Core.Packet(ObjectPacket);
        expect(objectPacket.id).toBe(ObjectPacket.id);
        expect(objectPacket.type).toBe(ObjectPacket.type);
        expect(objectPacket.body.bar).toBe(ObjectPacket.body.bar);

        payloadPacket = new Core.Packet(PayloadPacket);
        expect(payloadPacket.id).toBe(PayloadPacket.id);
        expect(payloadPacket.type).toBe(PayloadPacket.type);
        expect(payloadPacket.body.bar).toBe(PayloadPacket.body.bar);
    });

    it('can be deserialized from a data stream', function () {
        dataPacket = new Core.Packet(DataPacket);
        expect(dataPacket.id).toBe(1234);
        expect(dataPacket.type).toBe('kdeconnect.foo');
        expect(dataPacket.body.bar).toBe('baz');
    });

    it('can be serialized to a data stream', function () {
        dataData = dataPacket.serialize();
        expect(dataData[dataData.length - 1]).toBe('\n');

        objectData = objectPacket.serialize();
        expect(objectData[objectData.length - 1]).toBe('\n');

        payloadData = payloadPacket.serialize();
        expect(payloadData[payloadData.length - 1]).toBe('\n');
    });

    it('that has been serialized can be deserialized', function () {
        dataPacket = Core.Packet.deserialize(dataData);
        expect(dataPacket.id).not.toBe(1234);
        expect(dataPacket.type).toBe('kdeconnect.foo');
        expect(dataPacket.body.bar).toBe('baz');

        objectPacket = Core.Packet.deserialize(objectData);
        expect(objectPacket.id).not.toBe(ObjectPacket.id);
        expect(objectPacket.type).toBe(ObjectPacket.type);
        expect(objectPacket.body.bar).toBe(ObjectPacket.body.bar);

        payloadPacket = Core.Packet.deserialize(payloadData);
        expect(payloadPacket.id).not.toBe(PayloadPacket.id);
        expect(payloadPacket.type).toBe(PayloadPacket.type);
        expect(payloadPacket.body.bar).toBe(PayloadPacket.body.bar);
    });

    it('can be converted to a useful string representation', function () {
        expect(dataPacket.toString()).toBe('[object Packet:kdeconnect.foo]');
        expect(objectPacket.toString()).toBe('[object Packet:kdeconnect.foo]');
    });

    it('can check for a payload', function () {
        expect(dataPacket.hasPayload()).toBeFalse();
        expect(objectPacket.hasPayload()).toBeFalse();
        expect(payloadPacket.hasPayload()).toBeTrue();
    });
});

