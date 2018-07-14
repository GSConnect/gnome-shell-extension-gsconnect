'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;

const TCP_MIN_PORT = 1716;
const TCP_MAX_PORT = 1764;
const UDP_PORT = 1716;

const IP_PATTERN = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$|^(([a-zA-Z]|[a-zA-Z][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z]|[A-Za-z][A-Za-z0-9\-]*[A-Za-z0-9])$|^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$/;


/**
 * A convenience function for validating IP addresses
 *
 * @param {string} address - An IPv4 or IPv6 address (without port number)
 */
function ip_is_valid(address) {
    return IP_PATTERN.test(address);
}


/**
 * Lan.ChannelService consists of two parts.
 *
 * The TCP Listener listens on a port (usually 1716) and constructs a Channel
 * object from the incoming Gio.TcpConnection, emitting 'channel::'.
 *
 * The UDP Listener listens on a port 1716 for incoming JSON identity packets
 * which will have the TCP port for connections, while the TCP address is taken
 * from the UDP packet itself. If the device is not known, the address not
 * explicitly allowed and we're not "discoverable", we respond to  a TCP port for connection, taking the address from the
 * sender, emitting 'packet::'. It also broadcasts these packets to 255.255.255.255.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectLanChannelService',
    Properties: {
        'port': GObject.ParamSpec.uint(
            'port',
            'TCP Port',
            'The TCP port number the service is listening on',
            GObject.ParamFlags.READABLE,
            0, 1764,
            1716
        )
    }
}, class ChannelService extends GObject.Object {

    _init() {
        super._init();

        this.service = Gio.Application.get_default();

        this._initTcpListener();
        this._initUdpListener();

        // If we can't receive channels
        if (this._tcp === undefined && this._udp === undefined) {
            throw new Error();
        }

        // Monitor network changes
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            this._onNetworkChanged.bind(this)
        );
    }

    get allowed() {
        if (this._allowed === undefined) {
            this._allowed = new Set();
        }

        return this._allowed;
    }

    get port() {
        if (this._port === undefined) {
            return 0;
        }

        return this._port;
    }

    _onNetworkChanged(monitor, network_available) {
        if (network_available) {
            this.broadcast();
        }
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();
        let port = TCP_MIN_PORT;

        while (true) {
            try {
                this._tcp.add_inet_port(port, null);
            } catch (e) {
                if (port < TCP_MAX_PORT) {
                    port += 1;
                    continue;
                } else {
                    logWarning('Unable to bind to TCP port', 'Lan.ChannelService');
                    this._tcp.stop();
                    this._tcp.close();
                    return;
                }
            }

            if (this._tcp.active) {
                this._port = port;
                break;
            }
        }

        this._tcp.connect('incoming', this._onIncomingChannel.bind(this));

        log(`GSConnect: Using TCP port ${port}`);
    }

    _onIncomingChannel(listener, connection) {
        let channel = new Core.Channel();
        let host = connection.get_remote_address().address.to_string();

        let _connectedId = channel.connect('connected', (channel) => {
            channel.disconnect(_connectedId);
            channel.disconnect(_disconnectedId);

            // TODO: this is a hack for my mistake in GSConnect <= v10; it can
            //       be removed when it's safe to assume v10 is out of the wild
            if (!channel.identity.body.hasOwnProperty('deviceId')) {
                connection.close(null);
                return;
            }

            let devices = gsconnect.settings.get_strv('devices');

            // If this is a known device proceed...
            if (devices.includes(channel.identity.body.deviceId)) {
                // pass
            // ...but bail if it's not allowed and we're not discoverable
            } else if (!this.allowed.has(host) && !this.service.discoverable) {
                connection.close(null);
                return;
            }

            // Save the host address with default port for reconnecting later
            channel.identity.body.tcpHost = host;
            channel.identity.body.tcpPort = '1716';

            this.service._addDevice(channel.identity, channel);
        });

        let _disconnectedId = channel.connect('disconnected', (channel) => {
            channel.disconnect(_connectedId);
            channel.disconnect(_disconnectedId);
        });

        channel.accept(connection);
    }

    // TODO: support IPv6?
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
            logWarning('Unable to bind to UDP port 1716', 'Lan.ChannelService');
            this._udp.close();
            return;
        }

        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255',
            1716
        );

        // Input stream
        this._udp_stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this._udp.fd,
                close_fd: false
            })
        });

        // Watch input stream for incoming packets
        this._udp_source = this._udp.create_source(GLib.IOCondition.IN, null);
        this._udp_source.set_callback(this._onIncomingPacket.bind(this));
        this._udp_source.attach(null);

        log(`GSConnect: Using UDP port 1716`);
    }

    _onIncomingPacket(socket, condition) {
        try {
            // We "peek" for the host address first, then read the packet from a
            // stream since most of the socket methods don't work for us.
            let host = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            )[1].address.to_string();

            let data = this._udp_stream.read_line(null)[0].toString();
            let packet = new Core.Packet(data);

            // TODO: this is a hack for my mistake in GSConnect <= v10; it can
            //       be removed when it's safe to assume v10 is out of the wild
            if (!packet.body.hasOwnProperty('deviceId')) {
                return GLib.SOURCE_CONTINUE;
            }

            // Ignore our own broadcasts
            if (packet.body.deviceId === this.service.identity.body.deviceId) {
                return GLib.SOURCE_CONTINUE;
            }

            let devices = gsconnect.settings.get_strv('devices');

            // If this is a known device proceed...
            if (devices.includes(packet.body.deviceId)) {
                // pass
            // ...but bail if it's not allowed and we're not discoverable
            } else if (!this.allowed.has(host) && !this.service.discoverable) {
                return GLib.SOURCE_CONTINUE;
            }

            // Save the remote address for reconnecting
            packet.body.tcpHost = host;
            this.service._addDevice(packet, null);
        } catch (e) {
            logWarning(e, 'Reading UDP Packet');
        } finally {
            return GLib.SOURCE_CONTINUE;
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
    broadcast(address=null) {
        debug('broadcasting...');

        try {
            // Remember manual addresses so we know to accept connections
            if (address instanceof Gio.InetSocketAddress) {
                this.allowed.add(address.address.to_string());
            } else {
                address = this._udp_address;
            }

            this._udp.send_to(
                address,
                this.service.identity.toString(),
                null
            );
        } catch (e) {
            logWarning(e);
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
});


/**
 * File Transfers
 *
 * NOTE: transfers are always closed on completion
 *
 * Example Contruction:
 *  let transfer = new Protocol.Transfer({
 *      device: {Device.Device},
 *      size: {Number} size in bytes,
 *      input_stream: {Gio.InputStream} readable stream for uploads,
 *      output_stream: {Gio.OutputStream} writable stream for downloads
 *  });
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectLanTransfer',
}, class Transfer extends Core.Transfer {

    /**
     * Open a new channel for uploading (incoming connection)
     * @param {Number} port - A port between 1739-1764 for uploading
     *
     * Example usage:
     *  transfer.connect('connected', transfer => transfer.start());
     *  transfer.connect('succeeded'|'failed'|'cancelled', transfer => func());
     *  transfer.upload().then(port => {
     *      let packet = new Protocol.Packet({
     *          id: 0,
     *          type: 'kdeconnect.share.request',
     *          body: { filename: file.get_basename() },
     *          payloadSize: info.get_size(),
     *          payloadTransferInfo: { port: port }
     *      });
     *
     *      device._channel.send(packet);
     *  });
     */
    upload(port=1739) {
        debug(this.identity.body.deviceId);

        return new Promise((resolve, reject) => {
            // Start listening on new socket on a port between 1739-1764
            this._listener = new Gio.SocketListener();

            while (true) {
                try {
                    this._listener.add_inet_port(port, null);
                } catch (e) {
                    if (port < 1764) {
                        port += 1;
                        continue;
                    } else {
                        reject(new Error('Failed to open port'));
                    }
                }

                break;
            }

            // Wait for an incoming connection
            this._listener.accept_async(null, this.upload_accept.bind(this));

            // Return the incoming port for payloadTransferInfo
            resolve(port);
        });
    }

    async upload_accept(listener, res) {
        debug(this.identity.body.deviceId);

        try {
            this._connection = await new Promise((resolve, reject) => {
                try {
                    resolve(this._listener.accept_finish(res)[0]);
                } catch (e) {
                    reject(e);
                }
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._serverEncryption(this._connection);
            this.output_stream = this._connection.get_output_stream();
            this.emit('connected');
        } catch(e) {
            log('Error uploading: ' + e.message);
            debug(e);
            this.close();
        }
    }

    /**
     * Open a new channel for downloading (outgoing connection)
     * @param {Number} port - The port to connect to
     *
     * Example usage:
     *  transfer.connect('connected', transfer => transfer.start());
     *  transfer.connect('succeeded'|'failed'|'cancelled', transfer => func());
     *  transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
     */
    async download(port) {
        log(`Connecting to ${this.identity.body.deviceId}`);

        try {
            this._connection = await new Promise((resolve, reject) => {
                // Use @port and the address from GSettings
                let address = new Gio.InetSocketAddress({
                    address: Gio.InetAddress.new_from_string(
                        this.device.settings.get_string('tcp-host')
                    ),
                    port: port
                });

                // Connect
                let client = new Gio.SocketClient();

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e)
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this.input_stream = this._connection.get_input_stream();
            this.emit('connected');
        } catch (e) {
            log('Error downloading: ' + e.message);
            debug(e);
            this.close();
        }
    }
});

