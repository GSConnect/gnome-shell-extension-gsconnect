'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;


/**
 * Lan.ChannelService consists of two parts.
 *
 * The TCP Listener listens on a port (usually 1716) and constructs a Channel
 * object from the incoming Gio.TcpConnection, emitting 'channel::'.
 *
 * The UDP Listener listens on a port (usually 1716) for incoming JSON identity
 * packets containing a TCP port for connection, taking the address from the
 * sender, emitting 'packet::'. It also broadcasts these packets to 255.255.255.255.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectLanChannelService',
    Properties: {
        'discovering': GObject.ParamSpec.boolean(
            'discovering',
            'ServiceDiscovering',
            'Whether the TCP Listener is active',
            GObject.ParamFlags.READWRITE,
            true
        ),
        'port': GObject.ParamSpec.uint(
            'port',
            'TCP Port',
            'The TCP port number the service is listening on',
            GObject.ParamFlags.READABLE,
            0, 1764,
            1716
        )
    },
    Signals: {
        'channel': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        },
        'packet': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class ChannelService extends GObject.Object {

    _init() {
        super._init();

        this._port = 0;
        this._service = Gio.Application.get_default();
        this._initTcpListener();
        this._initUdpListener();

        // Monitor network changes
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            this._onNetworkChanged.bind(this)
        );
    }

    get discovering() {
        return this._tcp.active;
    }

    set discovering(bool) {
        (bool) ? this._tcp.start() : this._tcp.stop();
    }

    get port() {
        return this._port;
    }

    _onNetworkChanged(monitor, network_available) {
        if (network_available) {
            this.broadcast();
        }
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();
        let port = 1716;

        while (true) {
            try {
                this._tcp.add_inet_port(port, null);
            } catch (e) {
                debug('TcpListener: failed to bind to port ' + port + ': ' + e);

                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    this.destroy();
                    throw Error('TcpListener: Unable to find open port');
                }
            }

            if (this._tcp.active) {
                this._port = port;
                break;
            }
        }

        this._tcp.connect('incoming', this._receiveChannel.bind(this));

        log(`GSConnect: Using TCP port ${port}`);
    }

    /**
     * Receive a TCP connection and emit a Channel with 'channel::'
     */
    _receiveChannel(listener, connection) {
        let channel = new Core.Channel();
        let _tmp = channel.connect('connected', (channel) => {
            channel.disconnect(_tmp);
            // Save the remote address for reconnecting later
            let inetAddress = channel._connection.base_io_stream.get_remote_address();
            channel.identity.body.tcpHost = inetAddress.address.to_string();
            channel.identity.body.tcpPort = '1716';
            this.emit('channel', channel);
        });
        channel.accept(connection);
    }

    _initUdpListener() {
        this._udp = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        this._udp.init(null);
        let port = 1716;

        while (true) {
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: port
            });

            try {
                this._udp.bind(addr, false);
            } catch (e) {
                debug('UdpListener: failed to bind to port ' + port + ': ' + e);

                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    this._udp.close();
                    throw Error('UdpListener: Unable to find open port');
                }
            }

            break;
        }

        // Broadcast Address
        this._udp_address = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string('255.255.255.255'),
            port: this._udp.local_address.port
        });

        // Input stream
        this._input_stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this._udp.fd,
                close_fd: false
            })
        });

        // Watch input stream for incoming packets
        let source = this._udp.create_source(GLib.IOCondition.IN, null);
        source.set_callback(this._receivePacket.bind(this));
        source.attach(null);

        log(`GSConnect: Using UDP port ${port}`);
    }

    /**
     * Receive an identity packet and emit 'packet::'
     */
    _receivePacket() {
        let addr, data, flags, size;

        try {
            // 'Peek' the incoming address
            [size, addr, data, flags] = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._input_stream.read_line(null);
        } catch (e) {
            log('Error reading UDP packet: ' + e);
            return;
        }

        let packet = new Core.Packet(data.toString());

        if (packet.type !== 'kdeconnect.identity') {
            debug('Unexpected UDP packet type: ' + packet.type);
            return true;
        }

        // Save the remote address for reconnecting
        packet.body.tcpHost = addr.address.to_string();

        this.emit('packet', packet);

        return true;
    }

    /**
     * Broadcast an identity packet
     * @param {Core.Packet} identity - the identity packet to broadcast
     */
    broadcast(identity) {
        //debug(identity);

        try {
            this._udp.send_to(
                this._udp_address,
                this._service.identity.toString(),
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

