// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

import * as Gio from "gi://Gio";
import * as GLib from "gi://GLib";
import * as GObject from "gi://GObject";

const Config = imports.config;
const Core = imports.service.core;


/**
 * TCP Port Constants
 */
const PROTOCOL_PORT_DEFAULT = 1716;
const PROTOCOL_PORT_MIN = 1716;
const PROTOCOL_PORT_MAX = 1764;
const TRANSFER_MIN = 1739;
const TRANSFER_MAX = 1764;


/*
 * One-time check for Linux/FreeBSD socket options
 */
var _LINUX_SOCKETS = true;

try {
    // This should throw on FreeBSD
    Gio.Socket.new(
        Gio.SocketFamily.IPV4,
        Gio.SocketType.STREAM,
        Gio.SocketProtocol.TCP
    ).get_option(6, 5);
} catch (e) {
    _LINUX_SOCKETS = false;
}


/**
 * Configure a socket connection for the KDE Connect protocol.
 *
 * @param {Gio.SocketConnection} connection - The connection to configure
 */
function _configureSocket(connection) {
    try {
        if (_LINUX_SOCKETS) {
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT

        // FreeBSD constants
        // https://github.com/freebsd/freebsd/blob/master/sys/netinet/tcp.h#L159
        } else {
            connection.socket.set_option(6, 256, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 512, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 1024, 3); // TCP_KEEPCNT
        }

        // Do this last because an error setting the keepalive options would
        // result in a socket that never times out
        connection.socket.set_keepalive(true);
    } catch (e) {
        debug(e, 'Configuring Socket');
    }
}


/**
 * Lan.ChannelService consists of two parts:
 *
 * The TCP Listener listens on a port and constructs a Channel object from the
 * incoming Gio.TcpConnection.
 *
 * The UDP Listener listens on a port for incoming JSON identity packets which
 * include the TCP port, while the IP address is taken from the UDP packet
 * itself. We respond by opening a TCP connection to that address.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectLanChannelService',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'Certificate',
            'The TLS certificate',
            GObject.ParamFlags.READWRITE,
            Gio.TlsCertificate.$gtype
        ),
        'port': GObject.ParamSpec.uint(
            'port',
            'Port',
            'The port used by the service',
            GObject.ParamFlags.READWRITE,
            0,  GLib.MAXUINT16,
            PROTOCOL_PORT_DEFAULT
        ),
    },
}, class LanChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        // Track hosts we identify to directly, allowing them to ignore the
        // discoverable state of the service.
        this._allowed = new Set();

        //
        this._tcp = null;
        this._tcpPort = PROTOCOL_PORT_DEFAULT;
        this._udp4 = null;
        this._udp6 = null;

        // Monitor network status
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkAvailable = false;
        this._networkChangedId = 0;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        if (this.certificate === certificate)
            return;

        this._certificate = certificate;
        this.notify('certificate');
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    get port() {
        if (this._port === undefined)
            this._port = PROTOCOL_PORT_DEFAULT;

        return this._port;
    }

    set port(port) {
        if (this.port === port)
            return;

        this._port = port;
        this.notify('port');
    }

    _onNetworkChanged(monitor, network_available) {
        if (this._networkAvailable === network_available)
            return;

        this._networkAvailable = network_available;
        this.broadcast();
    }

    _initCertificate() {
        if (GLib.find_program_in_path(Config.OPENSSL_PATH) === null) {
            const error = new Error();
            error.name = _('OpenSSL not found');
            error.url = `${Config.PACKAGE_URL}/wiki/Error#openssl-not-found`;
            throw error;
        }

        const certPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'certificate.pem',
        ]);
        const keyPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'private.pem',
        ]);

        // Ensure a certificate exists with our id as the common name
        this._certificate = Gio.TlsCertificate.new_for_paths(certPath, keyPath,
            this.id);

        // If the service ID doesn't match the common name, this is probably a
        // certificate from an older version and we should amend ours to match
        if (this.id !== this._certificate.common_name)
            this._id = this._certificate.common_name;
    }

    _initTcpListener() {
        try {
            this._tcp = new Gio.SocketService();

            let tcpPort = this.port;
            const tcpPortMax = tcpPort +
                (PROTOCOL_PORT_MAX - PROTOCOL_PORT_MIN);

            while (tcpPort <= tcpPortMax) {
                try {
                    this._tcp.add_inet_port(tcpPort, null);
                    break;
                } catch (e) {
                    if (tcpPort < tcpPortMax) {
                        tcpPort++;
                        continue;
                    }

                    throw e;
                }
            }

            this._tcpPort = tcpPort;
            this._tcp.connect('incoming', this._onIncomingChannel.bind(this));
        } catch (e) {
            this._tcp.stop();
            this._tcp.close();
            this._tcp = null;

            throw e;
        }
    }

    async _onIncomingChannel(listener, connection) {
        try {
            const host = connection.get_remote_address().address.to_string();

            // Create a channel
            const channel = new Channel({
                backend: this,
                certificate: this.certificate,
                host: host,
                port: this.port,
            });

            // Accept the connection
            await channel.accept(connection);
            channel.identity.body.tcpHost = channel.host;
            channel.identity.body.tcpPort = this._tcpPort;
            channel.allowed = this._allowed.has(host);

            this.channel(channel);
        } catch (e) {
            debug(e);
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
            this._udp6.bind(sockAddr, true);

            // Input stream
            this._udp6_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
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
            this._udp4.bind(sockAddr, true);

            // Input stream
            this._udp4_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
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
        let host;

        // Try to peek the remote address
        try {
            host = socket.receive_message([], Gio.SocketMsgFlags.PEEK, null)[1]
                .address.to_string();
        } catch (e) {
            logError(e);
        }

        // Whether or not we peeked the address, we need to read the packet
        try {
            let data;

            if (socket === this._udp6)
                data = this._udp6_stream.read_line_utf8(null)[0];
            else
                data = this._udp4_stream.read_line_utf8(null)[0];

            // Discard the packet if we failed to peek the address
            if (host === undefined)
                return GLib.SOURCE_CONTINUE;

            const packet = new Core.Packet(data);
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

            debug(packet);

            // Create a new channel
            const channel = new Channel({
                backend: this,
                certificate: this.certificate,
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

    /**
     * Broadcast an identity packet
     *
     * If @address is not %null it may specify an IPv4 or IPv6 address to send
     * the identity packet directly to, otherwise it will be broadcast to the
     * default address, 255.255.255.255.
     *
     * @param {string} [address] - An optional target IPv4 or IPv6 address
     */
    broadcast(address = null) {
        try {
            if (!this._networkAvailable)
                return;

            // Try to parse strings as <host>:<port>
            if (typeof address === 'string') {
                const [host, portstr] = address.split(':');
                const port = parseInt(portstr) || this.port;
                address = Gio.InetSocketAddress.new_from_string(host, port);
            }

            // If we succeed, remember this host
            if (address instanceof Gio.InetSocketAddress) {
                this._allowed.add(address.address.to_string());

            // Broadcast to the network if no address is specified
            } else {
                debug('Broadcasting to LAN');
                address = this._udp_address;
            }

            // Broadcast on each open socket
            if (this._udp6 !== null)
                this._udp6.send_to(address, this.identity.serialize(), null);

            if (this._udp4 !== null)
                this._udp4.send_to(address, this.identity.serialize(), null);
        } catch (e) {
            debug(e, address);
        }
    }

    buildIdentity() {
        // Chain-up, then add the TCP port
        super.buildIdentity();
        this.identity.body.tcpPort = this._tcpPort;
    }

    start() {
        if (this.active)
            return;

        // Ensure a certificate exists
        if (this.certificate === null)
            this._initCertificate();

        // Start TCP/UDP listeners
        try {
            if (this._tcp === null)
                this._initTcpListener();

            if (this._udp4 === null && this._udp6 === null)
                this._initUdpListener();
        } catch (e) {
            // Known case of another application using the protocol defined port
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ADDRESS_IN_USE)) {
                e.name = _('Port already in use');
                e.url = `${Config.PACKAGE_URL}/wiki/Error#port-already-in-use`;
            }

            throw e;
        }

        // Monitor network changes
        if (this._networkChangedId === 0) {
            this._networkAvailable = this._networkMonitor.network_available;
            this._networkChangedId = this._networkMonitor.connect(
                'network-changed', this._onNetworkChanged.bind(this));
        }

        this._active = true;
        this.notify('active');
    }

    stop() {
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
            this._networkAvailable = false;
        }

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
            debug(e);
        }
    }
});


/**
 * Lan Channel
 *
 * This class essentially just extends Core.Channel to set TCP socket options
 * and negotiate TLS encrypted connections.
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectLanChannel',
}, class LanChannel extends Core.Channel {

    _init(params) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `lan://${this.host}:${this.port}`;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        this._certificate = certificate;
    }

    get peer_certificate() {
        if (this._connection instanceof Gio.TlsConnection)
            return this._connection.get_peer_certificate();

        return null;
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
                return PROTOCOL_PORT_DEFAULT;
        }

        return this._port;
    }

    set port(port) {
        this._port = port;
    }

    /**
     * Authenticate a TLS connection.
     *
     * @param {Gio.TlsConnection} connection - A TLS connection
     * @return {Promise} A promise for the operation
     */
    async _authenticate(connection) {
        // Standard TLS Handshake
        connection.validation_flags = Gio.TlsCertificateFlags.EXPIRED;
        connection.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;

        await connection.handshake_async(GLib.PRIORITY_DEFAULT,
            this.cancellable);

        // Get a settings object for the device
        let settings;

        if (this.device) {
            settings = this.device.settings;
        } else {
            const id = this.identity.body.deviceId;
            settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device',
                    true
                ),
                path: `/org/gnome/shell/extensions/gsconnect/device/${id}/`,
            });
        }

        // If we have a certificate for this deviceId, we can verify it
        const cert_pem = settings.get_string('certificate-pem');

        if (cert_pem !== '') {
            let certificate = null;
            let verified = false;

            try {
                certificate = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
                verified = certificate.is_same(connection.peer_certificate);
            } catch (e) {
                logError(e);
            }

            /* The certificate is incorrect for one of two reasons, but both
             * result in us resetting the certificate and unpairing the device.
             *
             * If the certificate failed to load, it is probably corrupted or
             * otherwise invalid. In this case, if we try to continue we will
             * certainly crash the Android app.
             *
             * If the certificate did not match what we expected the obvious
             * thing to do is to notify the user, however experience tells us
             * this is a result of the user doing something masochistic like
             * nuking the Android app data or copying settings between machines.
             */
            if (verified === false) {
                if (this.device) {
                    this.device.unpair();
                } else {
                    settings.reset('paired');
                    settings.reset('certificate-pem');
                }

                const name = this.identity.body.deviceName;
                throw new Error(`${name}: Authentication Failure`);
            }
        }

        return connection;
    }

    /**
     * Wrap the connection in Gio.TlsClientConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsClientConnection} The authenticated connection
     */
    _encryptClient(connection) {
        _configureSocket(connection);

        connection = Gio.TlsClientConnection.new(connection,
            connection.socket.remote_address);
        connection.set_certificate(this.certificate);

        return this._authenticate(connection);
    }

    /**
     * Wrap the connection in Gio.TlsServerConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsServerConnection} The authenticated connection
     */
    _encryptServer(connection) {
        _configureSocket(connection);

        connection = Gio.TlsServerConnection.new(connection, this.certificate);

        // We're the server so we trust-on-first-use and verify after
        const _id = connection.connect('accept-certificate', (connection) => {
            connection.disconnect(_id);
            return true;
        });

        return this._authenticate(connection);
    }

    /**
     * Negotiate an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        debug(`${this.address} (${this.uuid})`);

        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            // In principle this disposable wrapper could buffer more than the
            // identity packet, but in practice the remote device shouldn't send
            // any more data until the TLS connection is negotiated.
            const stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false,
            });

            const data = await stream.read_line_async(GLib.PRIORITY_DEFAULT,
                this.cancellable);
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);

            this.identity = new Core.Packet(data[0]);

            if (!this.identity.body.deviceId)
                throw new Error('missing deviceId');

            this._connection = await this._encryptClient(connection);
        } catch (e) {
            this.close();
            throw e;
        }
    }

    /**
     * Negotiate an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     */
    async open(connection) {
        debug(`${this.address} (${this.uuid})`);

        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            await connection.get_output_stream().write_all_async(
                this.backend.identity.serialize(),
                GLib.PRIORITY_DEFAULT,
                this.cancellable);

            this._connection = await this._encryptServer(connection);
        } catch (e) {
            this.close();
            throw e;
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        if (this.closed)
            return;

        debug(`${this.address} (${this.uuid})`);
        this._closed = true;
        this.notify('closed');

        this.backend.channels.delete(this.address);
        this.cancellable.cancel();

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
        const connection = await client.connect_async(address, cancellable)
            .then(this._encryptClient.bind(this));

        // Start the transfer
        const transferredSize = await target.splice_async(
            connection.input_stream,
            (Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
             Gio.OutputStreamSpliceFlags.CLOSE_TARGET),
            GLib.PRIORITY_DEFAULT, cancellable);

        // If we get less than expected, we've certainly got corruption
        if (transferredSize < packet.payloadSize) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: `Incomplete: ${transferredSize}/${packet.payloadSize}`,
            });

        // TODO: sometimes kdeconnect-android under-reports a file's size
        //       https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/1157
        } else if (transferredSize > packet.payloadSize) {
            logError(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: `Extra Data: ${transferredSize - packet.payloadSize}`,
            }));
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
        const acceptConnection = listener.accept_async(cancellable)
            .then(result => this._encryptServer(result[0]));

        // Create an upload request
        packet.body.payloadHash = this.checksum;
        packet.payloadSize = size;
        packet.payloadTransferInfo = {port: port};
        const requestUpload = this.sendPacket(new Core.Packet(packet),
            cancellable);

        // Request an upload stream, accept the connection and get the output
        const [, connection] = await Promise.all([requestUpload,
            acceptConnection]);

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
            const connection = await client.connect_async(address, null)
                .then(this._encryptClient.bind(this));

            connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }
});

