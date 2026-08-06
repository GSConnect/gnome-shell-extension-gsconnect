// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const Lan = await import(`file://${Config.PACKAGE_DATADIR}/service/backends/lan.js`);


describe('A LAN channel service', function () {
    let local, remote;
    let localChannel, remoteChannel;

    beforeAll(function () {
        const localCert = Gio.TlsCertificate.new_from_files(
            Utils.getDataPath('local-certificate.pem'),
            Utils.getDataPath('local-private.pem')
        );

        local = new Lan.ChannelService({
            certificate: localCert,
            port: 1717,
        });

        const remoteCert = Gio.TlsCertificate.new_from_files(
            Utils.getDataPath('remote-certificate.pem'),
            Utils.getDataPath('remote-private.pem')
        );

        remote = new Lan.ChannelService({
            certificate: remoteCert,
            port: 1718,
        });
    });

    afterAll(function () {
        local.destroy();
        remote.destroy();
    });

    it('can be started', function () {
        local.start();
        expect(local.active).toBeTrue();

        remote.start();
        expect(remote.active).toBeTrue();
    });

    it('can request and accept channels', function (done) {
        const localId = local.connect('channel', (service, channel) => {
            local.disconnect(localId);
            localChannel = channel;

            if (localChannel && remoteChannel)
                done();

            return true;
        });

        const remoteId = remote.connect('channel', (service, channel) => {
            remote.disconnect(remoteId);
            remoteChannel = channel;

            if (localChannel && remoteChannel)
                done();

            return true;
        });

        local.broadcast('127.0.0.1:1718');
    });

    it('tracks active channels', function () {
        // NOTE: the broadcasting side uses it's own port for reconnect
        localChannel = local.channels.get(`lan://127.0.0.1:${local.port}`);
        expect(localChannel).toBeDefined();

        remoteChannel = remote.channels.get(`lan://127.0.0.1:${local.port}`);
        expect(remoteChannel).toBeDefined();
    });

    describe('produces channels', function () {
        it('that can transfer packets', async function () {
            const outgoingPacket = new Core.Packet({
                type: 'kdeconnect.test',
                body: {
                    foo: GLib.uuid_string_random(),
                },
            });
            await localChannel.sendPacket(outgoingPacket);

            const incomingPacket = await remoteChannel.readPacket();
            expect(incomingPacket.type).toBe(outgoingPacket.type);
            expect(incomingPacket.body.foo).toBe(outgoingPacket.body.foo);
        });

        it('that can transfer payloads', async function () {
            // Uploading Channel
            const outgoingPacket = new Core.Packet({
                type: 'kdeconnect.test',
                body: {foo: 'bar'},
            });
            const sentBytes = new GLib.Bytes(GLib.uuid_string_random());
            const inputStream = Gio.MemoryInputStream.new_from_bytes(sentBytes);
            const localTransfer = new Core.Transfer({channel: localChannel});

            localTransfer.addStream(outgoingPacket, inputStream,
                sentBytes.get_size());
            localTransfer.start().catch(e => logError(e));

            // Downloading Channel
            const incomingPacket = await remoteChannel.readPacket();
            const outputStream = Gio.MemoryOutputStream.new_resizable();
            const remoteTransfer = new Core.Transfer({channel: remoteChannel});

            remoteTransfer.addStream(incomingPacket, outputStream);
            await remoteTransfer.start();
            const receivedBytes = outputStream.steal_as_bytes();

            expect(receivedBytes.equal(sentBytes)).toBeTrue();
        });
    });

    it('can be stopped', function () {
        local.stop();
        expect(local.active).toBeFalse();

        remote.stop();
        expect(remote.active).toBeFalse();
    });

    it('closes active channels when stopped', function () {
        expect(local.channels).toHaveSize(0);
        localChannel = null;

        expect(remote.channels).toHaveSize(0);
        remoteChannel = null;
    });

    // TODO: restarting stopped services
});


describe('LAN address formatting', function () {
    it('leaves IPv4 addresses unbracketed', function () {
        expect(Lan._formatAddress('192.168.1.10', 1716))
            .toBe('lan://192.168.1.10:1716');
    });

    it('brackets IPv6 addresses', function () {
        expect(Lan._formatAddress('2001:db8::1', 1716))
            .toBe('lan://[2001:db8::1]:1716');
    });

    it('brackets IPv6 addresses carrying a zone', function () {
        expect(Lan._formatAddress('fe80::1%wlan0', 1716))
            .toBe('lan://[fe80::1%wlan0]:1716');
    });
});


describe('LAN address parsing', function () {
    it('parses an IPv4 address with a port', function () {
        const addr = Lan._parseSocketAddress('192.168.1.10:1716', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('192.168.1.10');
        expect(addr.port).toBe(1716);
    });

    it('falls back to the default port', function () {
        const addr = Lan._parseSocketAddress('192.168.1.10', 1716);

        expect(addr).not.toBeNull();
        expect(addr.port).toBe(1716);
    });

    it('parses a bracketed IPv6 address with a port', function () {
        const addr = Lan._parseSocketAddress('[2001:db8::1]:1739', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('2001:db8::1');
        expect(addr.port).toBe(1739);
    });

    it('parses a bracketed IPv6 address without a port', function () {
        const addr = Lan._parseSocketAddress('[2001:db8::1]', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('2001:db8::1');
        expect(addr.port).toBe(1716);
    });

    // Earlier versions stored IPv6 addresses unbracketed in `last-connection`
    it('parses a bare IPv6 address', function () {
        const addr = Lan._parseSocketAddress('2001:db8::1', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('2001:db8::1');
        expect(addr.port).toBe(1716);
    });

    it('round-trips a formatted IPv6 address', function () {
        const uri = Lan._formatAddress('2001:db8::1', 1716);
        const addr = Lan._parseSocketAddress(uri.replace('lan://', ''), 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('2001:db8::1');
        expect(addr.port).toBe(1716);
    });

    it('parses an IPv6 address carrying a zone', function () {
        const addr = Lan._parseSocketAddress('[fe80::1%lo]:1716', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('fe80::1');
        expect(addr.port).toBe(1716);
    });

    it('tolerates an unresolvable zone', function () {
        const addr = Lan._parseSocketAddress('[fe80::1%nosuchiface0]:1716', 1716);

        expect(addr).not.toBeNull();
        expect(addr.address.to_string()).toBe('fe80::1');
        expect(addr.scope_id).toBe(0);
    });

    it('returns null for an unparseable address', function () {
        expect(Lan._parseSocketAddress('not-an-address', 1716)).toBeNull();
    });
});

