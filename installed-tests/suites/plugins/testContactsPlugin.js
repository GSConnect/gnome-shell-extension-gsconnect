// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';

import GLib from 'gi://GLib';

import Config from '../config.js';


const VCards = {
    valid: Utils.loadDataContents('vcard-valid.vcf'),
    invalid: Utils.loadDataContents('vcard-invalid.vcf'),
};


const Packets = {
    uidsResponse: {
        type: 'kdeconnect.contacts.response_uids_timestamps',
        body: {
            uids: ['valid', 'invalid'],
            valid: Date.now() + 10,
            invalid: Date.now() + 20,
        },
    },
    vcardsResponse: {
        type: 'kdeconnect.contacts.response_vcards',
        body: {
            uids: ['valid', 'invalid'],
            valid: VCards.valid,
            invalid: VCards.invalid,
        },
    },
};


/**
 * Mocked packet handling for the test device
 *
 * @param {object} packet - a KDE Connect protocol packet
 */
function handlePacket(packet) {
    if (packet.type === 'kdeconnect.contacts.request_all_uids_timestamps') {
        this.sendPacket(Packets.uidsResponse);

    } else if (packet.type === 'kdeconnect.contacts.request_vcards_by_uid') {
        const response = Packets.vcardsResponse;
        response.body = {uids: packet.body.uids};

        for (const uid of response.body.uids)
            response.body[uid] = VCards[uid];

        this.sendPacket(response);
    }
}


describe('The contacts plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.contacts.request_all_uids_timestamps',
                    'kdeconnect.contacts.request_vcards_by_uid',
                ],
                outgoingCapabilities: [
                    'kdeconnect.contacts.response_uids_timestamps',
                    'kdeconnect.contacts.response_vcards',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.contacts.response_uids_timestamps',
                    'kdeconnect.contacts.response_vcards',
                ],
                outgoingCapabilities: [
                    'kdeconnect.contacts.request_all_uids_timestamps',
                    'kdeconnect.contacts.request_vcards_by_uid',
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

        localPlugin = testRig.localDevice._plugins.get('contacts');
        expect(localPlugin).toBeDefined();
    });

    it('requests contacts when connected', async function () {
        GLib.test_expect_message('libebook-contacts',
            GLib.LogLevelFlags.LEVEL_WARNING, '*');

        testRig.setConnected(true);

        await localPlugin.awaitPacket('kdeconnect.contacts.response_vcards');
        expect(localPlugin._store.get_contact('valid')).toBeDefined();
    });

    it('clears the cache when requested', async function () {
        localPlugin.clearCache();

        // TODO: this seems to indicate we're deferring too much
        while (localPlugin._store.contacts.length)
            await Promise.idle();

        expect(localPlugin._store.contacts.length).toEqual(0);
    });

    it('handles and stores vCards (EBookContacts)', async function () {
        localPlugin._requestVCards(['valid']);

        await localPlugin.awaitPacket('kdeconnect.contacts.response_vcards');
        expect(localPlugin._store.get_contact('valid')).toBeDefined();
    });

    it('handles and stores vCards (native)', async function () {
        localPlugin.clearCache();

        // TODO: this seems to indicate we're deferring too much
        while (localPlugin._store.contacts.length)
            await Promise.idle();

        await import(`file://${Config.PACKAGE_DATADIR}/service/plugins/contacts.js`)
            .then(({setEBookContacts}) => setEBookContacts(null));

        localPlugin._requestVCards(['valid']);

        await localPlugin.awaitPacket('kdeconnect.contacts.response_vcards');
        expect(localPlugin._store.get_contact('valid')).toBeDefined();
    });
});
