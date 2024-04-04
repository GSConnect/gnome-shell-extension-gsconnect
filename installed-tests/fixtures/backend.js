// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Gio = imports.gi.Gio;
const GioUnix = imports.gi.GioUnix;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;
const Core = imports.service.core;


/**
 * TCP Port Constants
 */
const DEFAULT_PORT = 2716;
const TRANSFER_MIN = 2739;
const TRANSFER_MAX = 2764;


/**
 * A simple IP-based backend for tests. This should ostensibly be kept up to
 * date with backends/lan.js as it is essentially a clone without the TLS parts.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectMockChannelService',
    Properties: {
        'port': GObject.ParamSpec.uint(
            'port',
            'Port',
            'The port used by the service',
            GObject.ParamFlags.READWRITE,
            0,  GLib.MAXUINT16,
            DEFAULT_PORT
        ),
    },
}, class MockChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        //
        this._tcp = null;
        this._udp4 = null;
        this._udp6 = null;
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    get name() {
        return 'Mock Backend';
    }

    get port() {
        if (this._port === undefined)
            this._port = DEFAULT_PORT;

        return this._port;
    }

    set port(port) {
        if (this.port === port)
            return;

        this._port = port;
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();

        // NOTE: we brute-force an open port so tests can run concurrently
        while (true) {
            try {
                this._tcp.add_inet_port(this.port, null);
                break;
            } catch (e) {
                this._port++;
            }
        }

        this._tcp.connect('incoming', this._onIncomingChannel.bind(this));
    }

    async _onIncomingChannel(listener, connection) {
        try {
            const host = connection.get_remote_address().address.to_string();

            // Create a channel
            const channel = new Channel({
                backend: this,
                host: host,
                port: this.port,
            });

            // Accept the connection
            await channel.accept(connection);
            channel.identity.body.tcpHost = channel.host;
            channel.identity.body.tcpPort = this.port;

            this.channel(channel);
        } catch (e) {
            logError(e);
        }
    }

    _initUdpListener() {
        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255', this.port);

        try {
            this._udp6 = Gio.Socket.new(Gio.SocketFamily.IPV6,
                Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            this._udp6.set_broadcast(true);

            // Bind the socket
            const inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV6);
            const sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp6.bind(sockAddr, false);

            // Input stream
            this._udp6_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({
                    fd: this._udp6.fd,
                    close_fd: false,
                }),
            });

            // Watch socket for incoming packets
            this._udp6_source = this._udp6.create_source(GLib.IOCondition.IN, null);
            this._udp6_source.set_callback(this._onIncomingIdentity.bind(this, this._udp6));
            this._udp6_source.attach(null);
        } catch (e) {
            this._udp6 = null;
        }

        // Our IPv6 socket also supports IPv4; we're all done
        if (this._udp6 && this._udp6.speaks_ipv4()) {
            this._udp4 = null;
            return;
        }

        try {
            this._udp4 = Gio.Socket.new(Gio.SocketFamily.IPV4,
                Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            this._udp4.set_broadcast(true);

            // Bind the socket
            const inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV4);
            const sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp4.bind(sockAddr, false);

            // Input stream
            this._udp4_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({
                    fd: this._udp4.fd,
                    close_fd: false,
                }),
            });

            // Watch input socket for incoming packets
            this._udp4_source = this._udp4.create_source(GLib.IOCondition.IN, null);
            this._udp4_source.set_callback(this._onIncomingIdentity.bind(this, this._udp4));
            this._udp4_source.attach(null);
        } catch (e) {
            this._udp4 = null;

            // We failed to get either an IPv4 or IPv6 socket to bind
            if (this._udp6 === null)
                throw e;
        }
    }

    _onIncomingIdentity(socket) {
        let host, data, packet;

        // Try to peek the remote address
        try {
            host = socket.receive_message([], Gio.SocketMsgFlags.PEEK, null)[1]
                .address.to_string();
        } catch (e) {
            logError(e);
        }

        // Whether or not we peeked the address, we need to read the packet
        try {
            if (socket === this._udp6)
                data = this._udp6_stream.read_line_utf8(null)[0];
            else
                data = this._udp4_stream.read_line_utf8(null)[0];

            // Discard the packet if we failed to peek the address
            if (host === undefined)
                return;

            packet = new Core.Packet(data);
            packet.body.tcpHost = host;
            this._onIdentity(packet);
        } catch (e) {
            logError(e);
        }

        return GLib.SOURCE_CONTINUE;
    }

    async _onIdentity(packet) {
        try {
            // Bail if the deviceId is missing
            if (!packet.body.hasOwnProperty('deviceId'))
                return;

            // Silently ignore our own broadcasts
            if (packet.body.deviceId === this.identity.body.deviceId)
                return;

            // Create a new channel
            const channel = new Channel({
                backend: this,
                host: packet.body.tcpHost,
                port: packet.body.tcpPort,
                identity: packet,
            });

            // Check if channel is already open with this address
            if (this.channels.has(channel.address))
                return;

            this._channels.set(channel.address, channel);

            // Open a TCP connection
            const address = Gio.InetSocketAddress.new_from_string(
                packet.body.tcpHost, packet.body.tcpPort);

            const client = new Gio.SocketClient({enable_proxy: false});
            const connection = await client.connect_async(address,
                this.cancellable);

            // Connect the channel and attach it to the device on success
            await channel.open(connection);

            this.channel(channel);
        } catch (e) {
            logError(e);
        }
    }

    broadcast(address = null) {
        try {
            // Try to parse strings as <host>:<port>
            if (typeof address === 'string') {
                const [host, portstr] = address.split(':');
                const port = parseInt(portstr) || this.port;
                address = Gio.InetSocketAddress.new_from_string(host, port);
            }

            // Broadcast to the network if no address is specified
            if (!(address instanceof Gio.InetSocketAddress))
                address = this._udp_address;

            // Broadcast on each open socket
            if (this._udp6 !== null)
                this._udp6.send_to(address, this.identity.serialize(), null);

            if (this._udp4 !== null)
                this._udp4.send_to(address, this.identity.serialize(), null);
        } catch (e) {
            logError(e, address);
        }
    }

    buildIdentity() {
        this._identity = new Core.Packet({
            id: 0,
            type: 'kdeconnect.identity',
            body: {
                deviceId: this.id,
                deviceName: this.name,
                deviceType: 'desktop',
                protocolVersion: 7,
                incomingCapabilities: [],
                outgoingCapabilities: [],
                tcpPort: this.port,
            },
        });
    }

    start() {
        if (this.active)
            return;

        // Start TCP/UDP listeners
        if (this._tcp === null)
            this._initTcpListener();

        if (this._udp4 === null && this._udp6 === null)
            this._initUdpListener();

        this._active = true;
        this.notify('active');
    }

    stop() {
        if (this._tcp !== null) {
            this._tcp.stop();
            this._tcp.close();
            this._tcp = null;
        }

        if (this._udp6 !== null) {
            this._udp6_source.destroy();
            this._udp6_stream.close(null);
            this._udp6.close();
            this._udp6 = null;
        }

        if (this._udp4 !== null) {
            this._udp4_source.destroy();
            this._udp4_stream.close(null);
            this._udp4.close();
            this._udp4 = null;
        }

        for (const channel of this.channels.values())
            channel.close();

        this._active = false;
        this.notify('active');
    }

    destroy() {
        try {
            this.stop();
        } catch (e) {
            logError(e);
        }
    }
});


/**
 * A simple IP-based channel for tests
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectMockChannel',
}, class MockChannel extends Core.Channel {

    _init(params) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `mock://${this.host}:${this.port}`;
    }

    get host() {
        if (this._host === undefined)
            this._host = null;

        return this._host;
    }

    set host(host) {
        this._host = host;
    }

    get port() {
        if (this._port === undefined) {
            if (this.identity && this.identity.body.tcpPort)
                this._port = this.identity.body.tcpPort;
            else
                return DEFAULT_PORT;
        }

        return this._port;
    }

    set port(port) {
        this._port = port;
    }

    async accept(connection) {
        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            this.input_stream = new Gio.DataInputStream({
                base_stream: this._connection.get_input_stream(),
            });

            const [data] = await this.input_stream.read_line_async(
                GLib.PRIORITY_DEFAULT, this.cancellable);

            this.identity = new Core.Packet(data);

            if (!this.identity.body.deviceId)
                throw new Error('missing deviceId');
        } catch (e) {
            this.close();
            return e;
        }
    }

    async open(connection) {
        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            this.input_stream = new Gio.DataInputStream({
                base_stream: this._connection.get_input_stream(),
            });

            await connection.output_stream.write_all_async(
                this.backend.identity.serialize(),
                GLib.PRIORITY_DEFAULT,
                this.cancellable);
        } catch (e) {
            this.close();
            return e;
        }
    }

    close() {
        if (this.closed)
            return;

        this._closed = true;
        this.notify('closed');

        this.backend.channels.delete(this.address);
        this.cancellable.cancel();

        // These calls are not Promisified, so they can finish themselves
        if (this._connection)
            this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);

        if (this.input_stream)
            this.input_stream.close_async(GLib.PRIORITY_DEFAULT, null, null);

        if (this.output_stream)
            this.output_stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    async download(packet, target, cancellable = null) {
        const address = Gio.InetSocketAddress.new_from_string(this.host,
            packet.payloadTransferInfo.port);

        const client = new Gio.SocketClient({enable_proxy: false});
        const connection = await client.connect_async(address, cancellable);

        // Start the transfer
        const transferredSize = await connection.output_stream.splice_async(
            target, connection.input_stream,
            (Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
             Gio.OutputStreamSpliceFlags.CLOSE_TARGET),
            GLib.PRIORITY_DEFAULT, cancellable);

        if (transferredSize !== packet.payloadSize) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PARTIAL_INPUT,
                message: 'Transfer incomplete',
            });
        }
    }

    async upload(packet, source, size, cancellable = null) {
        // Start listening on the first available port between 1739-1764
        const listener = new Gio.SocketListener();
        let port = TRANSFER_MIN;

        while (port <= TRANSFER_MAX) {
            try {
                listener.add_inet_port(port, null);
                break;
            } catch (e) {
                if (port < TRANSFER_MAX) {
                    port++;
                    continue;
                } else {
                    throw e;
                }
            }
        }

        // Listen for the incoming connection
        const acceptConnection = listener.accept_async(cancellable);

        // Notify the device we're ready
        packet.body.payloadHash = this.checksum;
        packet.payloadSize = size;
        packet.payloadTransferInfo = {port: port};
        const sendPacket = this.sendPacket(new Core.Packet(packet),
            cancellable);

        // Accept the connection and configure the channel
        const [, connection] = await Promise([sendPacket, acceptConnection]);

        // Start the transfer
        const transferredSize = await connection.output_stream.splice_async(
            source,
            (Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
             Gio.OutputStreamSpliceFlags.CLOSE_TARGET),
            GLib.PRIORITY_DEFAULT, cancellable);

        if (transferredSize !== size) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PARTIAL_INPUT,
                message: 'Transfer incomplete',
            });
        }
    }

    async rejectTransfer(packet) {
        try {
            if (!packet || !packet.hasPayload())
                return;

            if (packet.payloadTransferInfo.port === undefined)
                return;

            const address = Gio.InetSocketAddress.new_from_string(this.host,
                packet.payloadTransferInfo.port);

            const client = new Gio.SocketClient({enable_proxy: false});
            const connection = await client.connect_async(address,
                this.cancellable);

            connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch (e) {
            logError(e, this.address);
        }
    }
});

