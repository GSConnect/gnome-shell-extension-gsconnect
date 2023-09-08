// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib} = imports.gi; //todo port import

const Utils = imports.fixtures.utils; //todo port import

const Core = imports.service.core; //todo port import
const Device = imports.service.device; //todo port import
const Lan = imports.service.backends.lan; //todo port import


describe('A LAN channel service', function () {
    let local, remote;
    let localChannel, remoteChannel;

    beforeAll(function () {
        const localCert = Gio.TlsCertificate.new_from_files(
            Utils.getDataPath('local-certificate.pem'),
            Utils.getDataPath('local-private.pem')
        );

        local = new Lan.ChannelService({
            id: GLib.uuid_string_random(),
            certificate: localCert,
            port: 1717,
        });

        const remoteCert = Gio.TlsCertificate.new_from_files(
            Utils.getDataPath('remote-certificate.pem'),
            Utils.getDataPath('remote-private.pem')
        );

        remote = new Lan.ChannelService({
            id: GLib.uuid_string_random(),
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

