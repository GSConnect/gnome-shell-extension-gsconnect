'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;

const TCP_MIN_PORT = 1716;
const TCP_MAX_PORT = 1764;
const UDP_PORT = 1716;


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
            channel = new Core.Channel({type: 'tcp'});
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
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: UDP_PORT
            });

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

    async _onIncomingIdentity() {
        try {
            // Most of the datagram methods don't work in GJS, so we "peek" for
            // the host address first...
            let host = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            )[1].address.to_string();

            // ...then read the packet from a stream, filling in the tcpHost
            let data = this._udp_stream.read_line_utf8(null)[0];
            let packet = new Core.Packet(data);
            packet.body.tcpHost = host;

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
                case this.allowed.has(host):
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
            let channel = new Core.Channel({type: 'tcp'});
            channel.identity = packet;

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

            // Notify the user of Proxy errors
            if ([40, 41, 42, 43].includes(e.code)) {
                e.name = 'ProxyError';
                this.service.notify_error(e);
            }
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
                debug(`Identifying to ${address.address.to_string()}`);
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
 * Lan File Transfers
 */
var Transfer = class Transfer extends Core.Transfer {

    /**
     * Connect to @port and read from the remote output stream into the local
     * input stream.
     *
     * When finished the channel and local input stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {Number} port - The port the transfer is listening for connection
     * @return {Boolean} - %true on success or %false on fail
     */
    async download(port) {
        let result = false;

        try {
            this._connection = await new Promise((resolve, reject) => {
                // Connect
                let client = new Gio.SocketClient({enable_proxy: false});

                // Use the address from GSettings with @port
                let address = Gio.InetSocketAddress.new_from_string(
                    this.device.settings.get_string('tcp-host'),
                    port
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
     * @param {Core.Packet} packet - The packet to send the transfer with
     * @return {Boolean} - %true on success or %false on fail
     */
    async upload(packet) {
        let port = 1739;
        let result = false;

        try {
            // Start listening on the first available port between 1739-1764
            this._listener = new Gio.SocketListener();

            while (port <= TCP_MAX_PORT) {
                try {
                    this._listener.add_inet_port(port, null);
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
                this._listener.accept_async(null, (source, res) => {
                    try {
                        resolve(this._listener.accept_finish(res)[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
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
};

