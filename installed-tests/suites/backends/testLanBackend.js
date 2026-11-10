// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const Lan = await import(`file://${Config.PACKAGE_DATADIR}/service/backends/lan.js`);


/**
 * Check whether a port is free to listen on.
 *
 * @param {number} port - A port
 * @returns {boolean} Whether the port is free
 */
function isPortFree(port) {
    const listener = new Gio.SocketListener();

    try {
        listener.add_inet_port(port, null);
        return true;
    } catch {
        return false;
    } finally {
        listener.close();
    }
}


/**
 * Wait for the other end of a connection to close it, ignoring anything it
 * sends before.
 *
 * @param {Gio.IOStream} connection - A connection
 * @returns {Promise} A promise for the operation
 */
async function waitForClose(connection) {
    let size;

    do {
        size = await new Promise(resolve => {
            connection.input_stream.read_bytes_async(4096,
                GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                    try {
                        resolve(stream.read_bytes_finish(res).get_size());
                    } catch {
                        // A reset connection is closed too
                        resolve(0);
                    }
                });
        });
    } while (size > 0);
}


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

        it('that free the port of an upload', async function () {
            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');
            const upload = localChannel.upload(packet,
                Gio.MemoryInputStream.new_from_bytes(bytes), bytes.get_size());

            const incomingPacket = await remoteChannel.readPacket();
            const output = Gio.MemoryOutputStream.new_resizable();
            await remoteChannel.download(incomingPacket, output);
            await upload;

            expect(isPortFree(packet.payloadTransferInfo.port)).toBeTrue();
        });

        it('that free the port of an upload that was not requested', async function () {
            spyOn(localChannel, 'sendPacket').and.rejectWith(
                new Error('Request failed'));

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');

            // Not waiting for the connection, which won't come
            await expectAsync(localChannel.upload(packet,
                Gio.MemoryInputStream.new_from_bytes(bytes),
                bytes.get_size())).toBeRejected();

            expect(isPortFree(packet.payloadTransferInfo.port)).toBeTrue();
        });

        it('that close a file whose upload failed', async function () {
            spyOn(localChannel, 'sendPacket').and.rejectWith(
                new Error('Request failed'));

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
            stream.close(null);

            const transfer = new Core.Transfer({channel: localChannel});
            transfer.addFile(packet, file);

            let source = null;
            const ensureStream = transfer._ensureStream.bind(transfer);
            spyOn(transfer, '_ensureStream').and.callFake(async (item, ...args) => {
                await ensureStream(item, ...args);
                source = item.source;
            });

            try {
                await expectAsync(transfer.start()).toBeRejected();

                expect(source).not.toBeNull();
                await Utils.waitFor(() => source.is_closed());
            } finally {
                file.delete(null);
            }
        });

        it('that stop a download the device does not encrypt', async function () {
            // Like a device that connects, but never completes the handshake
            const server = new Gio.SocketListener();
            const port = server.add_any_inet_port(null);
            let stalled = null;
            server.accept_async(null).then(([connection]) => {
                stalled = connection;
            });

            const packet = new Core.Packet({
                type: 'kdeconnect.test',
                body: {},
                payloadSize: 1,
                payloadTransferInfo: {port},
            });
            const cancellable = new Gio.Cancellable();

            try {
                const download = remoteChannel.download(packet,
                    Gio.MemoryOutputStream.new_resizable(), cancellable);
                await Utils.waitFor(() => stalled !== null);

                cancellable.cancel();
                await expectAsync(download).toBeRejected();
                await waitForClose(stalled);
            } finally {
                stalled?.close(null);
                server.close();
            }
        });

        it('that stop rejecting a transfer the device does not encrypt', async function () {
            // Like a device that connects, but never completes the handshake
            const server = new Gio.SocketListener();
            const port = server.add_any_inet_port(null);
            let stalled = null;
            server.accept_async(null).then(([connection]) => {
                stalled = connection;
            });

            const packet = new Core.Packet({
                type: 'kdeconnect.test',
                body: {},
                payloadSize: 1,
                payloadTransferInfo: {port},
            });
            remoteChannel._rejectTimeout = 200;

            try {
                await remoteChannel.rejectTransfer(packet);

                expect(stalled).not.toBeNull();
                await waitForClose(stalled);
            } finally {
                remoteChannel._rejectTimeout = undefined;
                stalled?.close(null);
                server.close();
            }
        });

        it('that are not unpaired by others connecting to an upload', async function () {
            const settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device', true),
                path: '/org/gnome/shell/extensions/gsconnect/device/' +
                    `${localChannel.identity.body.deviceId}/`,
            });
            const [, pem] = GLib.file_get_contents(
                Utils.getDataPath('remote-certificate.pem'));
            settings.set_string('certificate-pem', new TextDecoder().decode(pem));
            settings.set_boolean('paired', true);

            // Another host connects first, with another certificate
            const otherCert = Gio.TlsCertificate.new_from_files(
                Utils.getDataPath('local-certificate.pem'),
                Utils.getDataPath('local-private.pem'));
            let other = null;

            spyOn(localChannel, 'sendPacket').and.callFake(async request => {
                const address = Gio.InetSocketAddress.new_from_string(
                    '127.0.0.1', request.payloadTransferInfo.port);
                const connection = await new Gio.SocketClient({
                    enable_proxy: false,
                }).connect_async(address, null);

                other = Gio.TlsClientConnection.new(connection, address);
                other.set_certificate(otherCert);
                other.connect('accept-certificate', () => true);
                other.handshake_async(GLib.PRIORITY_DEFAULT, null)
                    .catch(() => {});
            });

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');

            try {
                await expectAsync(localChannel.upload(packet,
                    Gio.MemoryInputStream.new_from_bytes(bytes),
                    bytes.get_size())).toBeRejected();

                expect(settings.get_boolean('paired')).toBeTrue();
                expect(settings.get_string('certificate-pem')).not.toBe('');
            } finally {
                other?.base_io_stream.close(null);
                settings.reset('paired');
                settings.reset('certificate-pem');
            }
        });

        it('that record the identity they sent', function () {
            expect(localChannel.localIdentity).toBe(local.identity);
            expect(remoteChannel.localIdentity).toBe(remote.identity);
        });

        it('that record an identity rebuilt before they send it', async function () {
            // A device that never answers, so the channel is closed before
            // it's encrypted
            const server = new Gio.SocketListener();
            const port = server.add_any_inet_port(null);
            const address = Gio.InetSocketAddress.new_from_string('127.0.0.1',
                port);
            const connection = await new Gio.SocketClient({
                enable_proxy: false,
            }).connect_async(address, null);

            const channel = new Lan.Channel({
                backend: local,
                certificate: local.certificate,
                host: '127.0.0.1',
                port,
            });

            // The capabilities change after the channel is created
            const previous = local.identity;
            local.buildIdentity();
            const opening = channel.open(connection).catch(() => {});

            try {
                expect(local.identity).not.toBe(previous);
                expect(channel.localIdentity).toBe(local.identity);
            } finally {
                channel.close();
                await opening;
                server.close();
            }
        });

        it('that write packets one at a time', async function () {
            const packets = ['first', 'second', 'third'].map(name => {
                return new Core.Packet({type: 'kdeconnect.test', body: {name}});
            });

            await Promise.all(packets.map(packet => {
                return localChannel.sendPacket(packet);
            }));

            for (const packet of packets) {
                const received = await remoteChannel.readPacket();
                expect(received.body.name).toBe(packet.body.name);
            }
        });

        it('that only skip packets cancelled before they are written', async function () {
            const cancellable = new Gio.Cancellable();
            const first = new Core.Packet({
                type: 'kdeconnect.test',
                body: {name: 'first'},
            });
            const skipped = new Core.Packet({
                type: 'kdeconnect.test',
                body: {name: 'skipped'},
            });
            const last = new Core.Packet({
                type: 'kdeconnect.test',
                body: {name: 'last'},
            });

            // The first packet is written in full, even if cancelled
            const writeFirst = localChannel.sendPacket(first, cancellable);
            const writeSkipped = localChannel.sendPacket(skipped, cancellable);
            cancellable.cancel();

            await expectAsync(writeFirst).toBeResolved();
            await expectAsync(writeSkipped).toBeRejected();
            await localChannel.sendPacket(last);

            expect((await remoteChannel.readPacket()).body.name).toBe('first');
            expect((await remoteChannel.readPacket()).body.name).toBe('last');
        });

        it('that stop an upload the device does not encrypt', async function () {
            const cancellable = new Gio.Cancellable();
            let stalled = null;

            // Like a device that connects, but never completes the handshake
            spyOn(localChannel, 'sendPacket').and.callFake(async request => {
                const address = Gio.InetSocketAddress.new_from_string(
                    '127.0.0.1', request.payloadTransferInfo.port);
                const client = new Gio.SocketClient({enable_proxy: false});
                stalled = await client.connect_async(address, null);
            });

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');

            try {
                const upload = localChannel.upload(packet,
                    Gio.MemoryInputStream.new_from_bytes(bytes),
                    bytes.get_size(), cancellable);
                await Utils.waitFor(() => stalled !== null);

                cancellable.cancel();
                await expectAsync(upload).toBeRejected();
                await waitForClose(stalled);
            } finally {
                stalled?.close(null);
            }
        });

        it('that close a connection for an upload that was not requested', async function () {
            let client = null;

            // The device connects, but the request fails to send
            spyOn(localChannel, 'sendPacket').and.callFake(async request => {
                const address = Gio.InetSocketAddress.new_from_string(
                    '127.0.0.1', request.payloadTransferInfo.port);
                client = await new Gio.SocketClient({enable_proxy: false})
                    .connect_async(address, null);

                // Fail once the connection is accepted
                await Utils.waitFor(() => localChannel._encryptServer.calls.any());
                throw new Error('Request failed');
            });
            spyOn(localChannel, '_encryptServer').and.callThrough();

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');

            try {
                await expectAsync(localChannel.upload(packet,
                    Gio.MemoryInputStream.new_from_bytes(bytes),
                    bytes.get_size())).toBeRejected();

                await waitForClose(client);
            } finally {
                client?.close(null);
            }
        });

        it('that close a connection accepted once an upload failed', async function () {
            let client = null;
            let requestFailed;
            const failure = new Promise(resolve => (requestFailed = resolve));

            // The connection is accepted, but only reported once the request
            // failed
            const accept = Gio.SocketListener.prototype.accept_async;
            spyOn(Gio.SocketListener.prototype, 'accept_async').and.callFake(
                async function (...args) {
                    const result = await accept.call(this, ...args);
                    await failure;
                    return result;
                });

            spyOn(localChannel, 'sendPacket').and.callFake(async request => {
                const address = Gio.InetSocketAddress.new_from_string(
                    '127.0.0.1', request.payloadTransferInfo.port);
                client = await new Gio.SocketClient({enable_proxy: false})
                    .connect_async(address, null);

                throw new Error('Request failed');
            });

            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const bytes = new GLib.Bytes('upload');

            try {
                await expectAsync(localChannel.upload(packet,
                    Gio.MemoryInputStream.new_from_bytes(bytes),
                    bytes.get_size())).toBeRejected();
                requestFailed();

                await waitForClose(client);
            } finally {
                client?.close(null);
            }
        });

        it('that close a file whose size can not be read', async function () {
            const packet = new Core.Packet({type: 'kdeconnect.test', body: {}});
            const [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
            stream.close(null);
            spyOn(file, 'query_info_async').and.rejectWith(
                new Error('Query failed'));

            const transfer = new Core.Transfer({channel: localChannel});
            transfer.addFile(packet, file);

            let source = null;
            const ensureStream = transfer._ensureStream.bind(transfer);
            spyOn(transfer, '_ensureStream').and.callFake(async (item, ...args) => {
                try {
                    await ensureStream(item, ...args);
                } finally {
                    source = item.source;
                }
            });

            try {
                await expectAsync(transfer.start()).toBeRejected();

                expect(source).not.toBeNull();
                await Utils.waitFor(() => source.is_closed());
            } finally {
                file.delete(null);
            }
        });

        it('that close a file whose download failed', async function () {
            // Nothing is listening on the port of the payload
            const packet = new Core.Packet({
                type: 'kdeconnect.test',
                body: {},
                payloadSize: 1,
                payloadTransferInfo: {port: 9},
            });
            const [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
            stream.close(null);

            const transfer = new Core.Transfer({channel: remoteChannel});
            transfer.addFile(packet, file);

            let target = null;
            const ensureStream = transfer._ensureStream.bind(transfer);
            spyOn(transfer, '_ensureStream').and.callFake(async (item, ...args) => {
                await ensureStream(item, ...args);
                target = item.target;
            });

            try {
                await expectAsync(transfer.start()).toBeRejected();

                expect(target).not.toBeNull();
                await Utils.waitFor(() => target.is_closed());
            } finally {
                file.delete(null);
            }
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

