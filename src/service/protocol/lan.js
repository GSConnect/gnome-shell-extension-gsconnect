'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.protocol.core;


/**
 * TCP Port Constants
 */
const TCP_MIN_PORT = 1716;
const TCP_MAX_PORT = 1764;
const UDP_PORT = 1716;


/**
 * One-time check for Linux/FreeBSD socket options
 */
var _LINUX_SOCKETS = false;

try {
    // This should throw on FreeBSD
    // https://github.com/freebsd/freebsd/blob/master/sys/netinet/tcp.h#L159
    new Gio.Socket({
        family: Gio.SocketFamily.IPV4,
        protocol: Gio.SocketProtocol.TCP,
        type: Gio.SocketType.STREAM
    }).get_option(6, 5);

    // Otherwise we can use Linux socket options
    debug('Using Linux socket options');
    _LINUX_SOCKETS = true;
} catch (e) {
    debug('Using FreeBSD socket options');
    _LINUX_SOCKETS = false;
}


/**
 * Lan.ChannelService consists of two parts.
 *
 * The TCP Listener listens on a port (usually 1716) and constructs a Channel
 * object from the incoming Gio.TcpConnection.
 *
 * The UDP Listener listens on a port 1716 for incoming JSON identity packets
 * which include the TCP port for connections, while the IP address is taken
 * from the UDP packet itself. We respond to incoming packets by opening a TCP
 * connection and broadcast outgoing packets to 255.255.255.255.
 */
var ChannelService = class ChannelService {

    constructor() {
        this.allowed = new Set();
        this.connecting = new Map();

        // Start TCP/UDP listeners
        this._initUdpListener();
        this._initTcpListener();

        // Monitor network changes
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkAvailable = this._networkMonitor.network_available;
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            this._onNetworkChanged.bind(this)
        );
    }

    get service() {
        return Gio.Application.get_default();
    }

    _onNetworkChanged(monitor, network_available) {
        if (this._networkAvailable !== network_available) {
            this._networkAvailable = network_available;
            this.broadcast();
        }
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();

        try {
            this._tcp.add_inet_port(TCP_MIN_PORT, null);
        } catch (e) {
            this._tcp.stop();
            this._tcp.close();

            // The UDP listener must have succeeded so shut it down, too
            this._udp_source.destroy();
            this._udp_stream.close(null);
            this._udp.close();

            throw e;
        }

        this._tcp.connect('incoming', this._onIncomingChannel.bind(this));
    }

    async _onIncomingChannel(listener, connection) {
        let channel, host, device;

        try {
            channel = new Channel();
            host = connection.get_remote_address().address.to_string();

            // Cancel any connection still resolving with this host
            if (this.connecting.has(host)) {
                debug(`Cancelling current connection with ${host}`);
                this.connecting.get(host).close();
                this.connecting.delete(host);
            }

            // Track this connection to avoid a race condition
            debug(`Accepting connection from ${host}`);
            this.connecting.set(host, channel);

            // Accept the connection
            await channel.accept(connection);
            channel.identity.body.tcpHost = host;
            channel.identity.body.tcpPort = '1716';

            device = this.service._devices.get(channel.identity.body.deviceId);

            switch (true) {
                // An existing device
                case (device !== undefined):
                    break;

                // A response to a "direct" broadcast, or we're discoverable
                case this.allowed.has(host):
                case this.service.discoverable:
                    device = await this.service._ensureDevice(channel.identity);
                    break;

                // ...otherwise bail
                default:
                    channel.close();
                    throw Error('device not allowed');
            }

            // Attach a device to the channel
            channel.attach(device);
        } catch (e) {
            debug(e);
        } finally {
            this.connecting.delete(host);
        }
    }

    _initUdpListener() {
        this._udp = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        this._udp.init(null);

        try {
            let addr = Gio.InetSocketAddress.new_from_string(
                '0.0.0.0',
                UDP_PORT
            );

            this._udp.bind(addr, false);
        } catch (e) {
            this._udp.close();

            throw e;
        }

        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255',
            UDP_PORT
        );

        // Input stream
        this._udp_stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this._udp.fd,
                close_fd: false
            })
        });

        // Watch input socket for incoming packets
        this._udp_source = this._udp.create_source(GLib.IOCondition.IN, null);
        this._udp_source.set_callback(this._onIncomingIdentity.bind(this));
        this._udp_source.attach(null);
    }

    _onIncomingIdentity() {
        let host, data, packet;

        // Try to peek the remote address, but don't prevent reading the data
        try {
            host = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            )[1].address.to_string();
        } catch (e) {
            logError(e);
        }

        try {
            data = this._udp_stream.read_line_utf8(null)[0];

            // Only process the packet if we succeeded in peeking the address
            if (host !== undefined) {
                packet = new Core.Packet(data);
                packet.body.tcpHost = host;
                this._onIdentity(packet);
            }
        } catch (e) {
            logError(e);
        }

        return GLib.SOURCE_CONTINUE;
    }

    async _onIdentity(packet) {
        try {
            // Bail if the deviceId is missing
            if (!packet.body.hasOwnProperty('deviceId')) {
                warning('missing deviceId', packet.body.deviceName);
                return;
            }

            // Silently ignore our own broadcasts
            if (packet.body.deviceId === this.service.identity.body.deviceId) {
                return;
            }

            debug(packet);

            let device = this.service._devices.get(packet.body.deviceId);

            switch (true) {
                // Proceed if this is an existing device...
                case (device !== undefined):
                    break;

                // Or the service is discoverable or host is allowed...
                case this.service.discoverable:
                case this.allowed.has(packet.body.tcpHost):
                    device = this.service._ensureDevice(packet);
                    break;

                // ...otherwise bail
                default:
                    warning('device not allowed', packet.body.deviceName);
                    return;
            }

            // Silently ignore broadcasts from connected devices, but update
            // from the identity packet
            if (device._channel !== null) {
                debug('already connected');
                device._handleIdentity(packet);
                return;
            }

            // Create a new channel
            let channel = new Channel({identity: packet});

            let connection = await new Promise((resolve, reject) => {
                let address = Gio.InetSocketAddress.new_from_string(
                    packet.body.tcpHost,
                    packet.body.tcpPort
                );
                let client = new Gio.SocketClient({enable_proxy: false});

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Connect the channel and attach it to the device on success
            await channel.open(connection);
            channel.attach(device);
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
            if (!this._networkAvailable) {
                debug('Network unavailable; aborting');
                return;

            // Remember manual addresses so we know to accept connections
            } else if (address instanceof Gio.InetSocketAddress) {
                this.allowed.add(address.address.to_string());

            // Only broadcast to the network if no address is specified
            } else {
                debug('Broadcasting to LAN');
                address = this._udp_address;
            }

            this._udp.send_to(address, `${this.service.identity}`, null);
        } catch (e) {
            warning(e);
        }
    }

    destroy() {
        this._networkMonitor.disconnect(this._networkChangedId);

        this._tcp.stop();
        this._tcp.close();

        this._udp_source.destroy();
        this._udp_stream.close(null);
        this._udp.close();
    }
};


/**
 * Lan Base Channel
 *
 * This class essentially just extends Core.Channel to set TCP socket options
 * and negotiate TLS encrypted connections.
 */
var Channel = class Channel extends Core.Channel {

    get certificate() {
        return this._connection.get_peer_certificate();
    }

    get type() {
        return 'tcp';
    }

    _initSocket(connection) {
        connection.socket.set_keepalive(true);

        if (_LINUX_SOCKETS) {
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
        } else {
            connection.socket.set_option(6, 256, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 512, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 1024, 3); // TCP_KEEPCNT
        }

        return connection;
    }

    /**
     * Handshake Gio.TlsConnection
     */
    _handshake(connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = Gio.TlsCertificateFlags.EXPIRED;
            connection.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;

            connection.handshake_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (connection, res) => {
                    try {
                        resolve(connection.handshake_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _authenticate(connection) {
        try {
            // Standard TLS Handshake
            await this._handshake(connection);

            // Get a GSettings object for this deviceId
            let id = (this.device) ? this.device.id : this.identity.body.deviceId;
            let settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device',
                    true
                ),
                path: `/org/gnome/shell/extensions/gsconnect/device/${id}/`
            });
            let cert_pem = settings.get_string('certificate-pem');

            // If we have a certificate for this deviceId, we can verify it
            if (cert_pem !== '') {
                let certificate = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
                let valid = certificate.is_same(connection.peer_certificate);

                // This is a fraudulent certificate; notify the user
                if (!valid) {
                    let error = new Error();
                    error.name = 'AuthenticationError';
                    error.deviceName = this.identity.body.deviceName;
                    error.deviceHost = connection.base_io_stream.get_remote_address().address.to_string();
                    this.service.notify_error(error);

                    throw error;
                }
            }

            return connection;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Wrap the connection in Gio.TlsClientConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsServerConnection} - The authenticated connection
     */
    _clientEncryption(connection) {
        connection = Gio.TlsClientConnection.new(
            connection,
            connection.socket.remote_address
        );
        connection.set_certificate(this.service.certificate);

        return this._authenticate(connection);
    }

    /**
     * Wrap the connection in Gio.TlsServerConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsServerConnection} - The authenticated connection
     */
    _serverEncryption(connection) {
        connection = Gio.TlsServerConnection.new(
            connection,
            this.service.certificate
        );

        // We're the server so we trust-on-first-use and verify after
        let _id = connection.connect('accept-certificate', (connection) => {
            connection.disconnect(_id);
            return true;
        });

        return this._authenticate(connection);
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            debug('receiving identity');

            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        let data = stream.read_line_finish_utf8(res)[0];
                        stream.close(null);

                        // Store the identity as an object property
                        this.identity = new Core.Packet(data);

                        // Reject connections without a deviceId
                        if (!this.identity.body.deviceId) {
                            throw new Error('missing deviceId');
                        }

                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            debug('sending identity');

            connection.output_stream.write_all_async(
                `${this.service.identity}`,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Negotiate an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Negotiate an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     */
    async open(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        debug(`${this.constructor.name} (${this.type})`);

        // Cancel any queued operations
        this.cancellable.cancel();

        // Close any streams
        [this._connection, this.input_stream, this.output_stream].map(stream => {
            try {
                stream.close(null);
            } catch (e) {
                // Silence errors
            }
        });
    }

    /**
     * Attach to @device as the default channel used for packet exchange.
     *
     * @param {Device.Device} device - The device to attach to
     */
    attach(device) {
        try {
            // Detach any existing channel
            if (device._channel && device._channel !== this) {
                device._channel.cancellable.disconnect(device._channel._id);
                device._channel.close();
            }

            // Attach the new channel and parse it's identity
            device._channel = this;
            this._id = this.cancellable.connect(device._setDisconnected.bind(device));
            device._handleIdentity(this.identity);

            // Setup streams for packet exchange
            this.input_stream = new Gio.DataInputStream({
                base_stream: this._connection.input_stream
            });

            this.output_queue = [];
            this.output_stream = this._connection.output_stream;

            // Start listening for packets
            this.receive(device);

            // Emit connected:: if necessary
            if (!device.connected) {
                device._setConnected();
            }
        } catch (e) {
            logError(e);
            this.close();
        }
    }
};


/**
 * Lan Transfer Channel
 */
var Transfer = class Transfer extends Channel {

    /**
     * @param {object} params - Transfer parameters
     * @param {Device.Device} params.device - The device that owns this transfer
     * @param {Gio.InputStream} params.input_stream - The input stream (read)
     * @param {Gio.OutputStream} params.output_stream - The output stream (write)
     * @param {number} params.size - The size of the transfer in bytes
     */
    constructor(params) {
        super(params);

        // The device tracks transfers it owns so they can be closed from the
        // notification action.
        this.device._transfers.set(this.uuid, this);
    }

    /**
     * Override to untrack the transfer UUID
     */
    close() {
        this.device._transfers.delete(this.uuid);
        super.close();
    }

    /**
     * Connect to @port and read from the remote output stream into the local
     * input stream.
     *
     * When finished the channel and local input stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {number} port - The port the transfer is listening for connection
     * @return {boolean} - %true on success or %false on fail
     */
    async download() {
        let result = false;

        try {
            this._connection = await new Promise((resolve, reject) => {
                // Connect
                let client = new Gio.SocketClient({enable_proxy: false});

                // Use the address from GSettings with @port
                let address = Gio.InetSocketAddress.new_from_string(
                    this.device.settings.get_string('tcp-host'),
                    this.port
                );

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this.input_stream = this._connection.get_input_stream();

            // Start the transfer
            result = await this._transfer();
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }

    /**
     * Start listening on the first available port for an incoming connection,
     * then send @packet with the payload transfer info. When the connection is
     * accepted write to the remote input stream from the local output stream.
     *
     * When finished the channel and local output stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {Core.Packet} packet - The packet describing the transfer
     * @return {boolean} - %true on success or %false on fail
     */
    async upload(packet) {
        let port = 1739;
        let result = false;

        try {
            // Start listening on the first available port between 1739-1764
            let listener = new Gio.SocketListener();

            while (port <= TCP_MAX_PORT) {
                try {
                    listener.add_inet_port(port, null);
                    break;
                } catch (e) {
                    if (port < TCP_MAX_PORT) {
                        port++;
                        continue;
                    } else {
                        throw e;
                    }
                }
            }

            // Await the incoming connection
            let connection = new Promise((resolve, reject) => {
                listener.accept_async(
                    this.cancellable,
                    (listener, res, source_object) => {
                        try {
                            resolve(listener.accept_finish(res)[0]);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Notify the device we're ready
            packet.body.payloadHash = this.checksum;
            packet.payloadSize = this.size;
            packet.payloadTransferInfo = {port: port};
            this.device.sendPacket(packet);

            // Accept the connection and configure the channel
            this._connection = await connection;
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._serverEncryption(this._connection);
            this.output_stream = this._connection.get_output_stream();

            // Start the transfer
            result = await this._transfer();
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }

    /**
     * Transfer using g_output_stream_splice()
     *
     * @return {Boolean} - %true on success, %false on failure.
     */
    async _transfer() {
        let result = false;

        try {
            result = await new Promise((resolve, reject) => {
                this.output_stream.splice_async(
                    this.input_stream,
                    Gio.OutputStreamSpliceFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    this.cancellable,
                    (source, res) => {
                        try {
                            if (source.splice_finish(res) < this.size) {
                                throw new Error('incomplete data');
                            }

                            resolve(true);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }
};

