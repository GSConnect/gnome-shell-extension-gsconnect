// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Utils = imports.fixtures.utils;


const Packets = {
    summary: {
        type: 'kdeconnect.sms.messages',
        body: {
            messages: [
                {
                    addresses: [
                        {
                            address: '555-555-5555',
                        },
                    ],
                    body: 'incoming message of thread 1',
                    date: 1588334621800,
                    type: 1,
                    read: 0,
                    thread_id: 1,
                    _id: 1,
                    sub_id: 1,
                    event: 1,
                },
                {
                    addresses: [
                        {
                            address: '555-555-5556',
                        },
                    ],
                    body: 'incoming message of thread 2',
                    date: 1588334621500,
                    type: 1,
                    read: 0,
                    thread_id: 2,
                    _id: 3,
                    sub_id: 1,
                    event: 1,
                },
            ],
            version: 2,
        },
    },
    thread_one: {
        type: 'kdeconnect.sms.messages',
        body: {
            messages: [
                {
                    addresses: [
                        {
                            address: '555-555-5555',
                        },
                    ],
                    body: 'incoming message of thread 1',
                    date: 1588334621800,
                    type: 1,
                    read: 0,
                    thread_id: 1,
                    _id: 1,
                    sub_id: 1,
                    event: 1,
                },
                {
                    addresses: [
                        {
                            address: '555-555-5555',
                        },
                    ],
                    body: 'outgoing message of thread 1',
                    date: 1588334621700,
                    type: 2,
                    read: 0,
                    thread_id: 1,
                    _id: 2,
                    sub_id: 1,
                    event: 1,
                },
            ],
            version: 2,
        },
    },
    thread_two: {
        type: 'kdeconnect.sms.messages',
        body: {
            messages: [
                {
                    addresses: [
                        {
                            address: '555-555-5556',
                        },
                    ],
                    body: 'incoming message of thread 2',
                    date: 1588334621500,
                    type: 1,
                    read: 0,
                    thread_id: 2,
                    _id: 3,
                    sub_id: 1,
                    event: 1,
                },
                {
                    addresses: [
                        {
                            address: '555-555-5556',
                        },
                    ],
                    body: 'outgoing message of thread 2',
                    date: 1588334621400,
                    type: 2,
                    read: 0,
                    thread_id: 2,
                    _id: 4,
                    sub_id: 1,
                    event: 1,
                },
            ],
            version: 2,
        },
    },
};


function handlePacket(packet) {
    switch (packet.type) {
        case 'kdeconnect.sms.request_conversations':
            this.sendPacket(Packets.summary);
            break;

        case 'kdeconnect.sms.request_conversation':
            if (packet.body.threadID === '1')
                this.sendPacket(Packets.thread_one);

            else if (packet.body.threadID === '2')
                this.sendPacket(Packets.thread_two);

            break;
    }
}


describe('The sms plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.sms.messages',
                    'kdeconnect.sms.request',
                    'kdeconnect.sms.request_conversation',
                    'kdeconnect.sms.request_conversations',
                ],
                outgoingCapabilities: [
                    'kdeconnect.sms.messages',
                    'kdeconnect.sms.request',
                    'kdeconnect.sms.request_conversation',
                    'kdeconnect.sms.request_conversations',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.sms.messages',
                    'kdeconnect.sms.request',
                    'kdeconnect.sms.request_conversation',
                    'kdeconnect.sms.request_conversations',
                ],
                outgoingCapabilities: [
                    'kdeconnect.sms.messages',
                    'kdeconnect.sms.request',
                    'kdeconnect.sms.request_conversation',
                    'kdeconnect.sms.request_conversations',
                ],
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
        remoteDevice.handlePacket = handlePacket.bind(remoteDevice);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin)
            spyOn(localPlugin, 'handlePacket').and.callThrough();
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('sms');

        expect(localPlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        spyOn(localPlugin, '_requestConversations');

        testRig.setConnected(true);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeTrue();
    });

    it('requests messages when connected', function () {
        spyOn(localPlugin, '_requestConversations');

        localPlugin.connected();
        expect(localPlugin._requestConversations).toHaveBeenCalled();
    });

    it('can request a list of conversations', async function () {
        spyOn(localPlugin, '_handleDigest');

        localPlugin._requestConversations();

        await localPlugin.awaitPacket('kdeconnect.sms.messages');
        expect(localPlugin._handleDigest).toHaveBeenCalled();
    });

    it('can request full conversations', async function () {
        spyOn(localPlugin, '_handleDigest').and.callThrough();
        spyOn(localPlugin, '_handleThread').and.callThrough();
        spyOn(localPlugin, '_requestConversation').and.callThrough();

        localPlugin._requestConversations();

        await localPlugin.awaitPacket('kdeconnect.sms.messages');
        expect(localPlugin._handleDigest).toHaveBeenCalled();
        expect(localPlugin._requestConversation).toHaveBeenCalledTimes(2);

        localPlugin.handlePacket.calls.reset();

        await localPlugin.awaitPacket('kdeconnect.sms.messages');
        expect(localPlugin._handleThread).toHaveBeenCalled();
    });

    it('only requests new or updated converations', async function () {
        spyOn(localPlugin, '_handleDigest').and.callThrough();
        spyOn(localPlugin, '_handleThread').and.callThrough();
        spyOn(localPlugin, '_requestConversation').and.callThrough();

        localPlugin._requestConversations();

        await localPlugin.awaitPacket('kdeconnect.sms.messages');
        expect(localPlugin._handleDigest).toHaveBeenCalled();

        expect(localPlugin._requestConversation).not.toHaveBeenCalled();
    });

    it('can send SMS messages', async function () {
        spyOn(remoteDevice, 'handlePacket').and.callThrough();

        localPlugin.sendSms('555-555-5555', 'message body');

        await remoteDevice.awaitPacket('kdeconnect.sms.request', {
            sendSms: true,
            phoneNumber: '555-555-5555',
            messageBody: 'message body',
        });
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeFalse();
    });
});

