"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);


// Packet Types
var TYPE_IDENTITY = "kdeconnect.identity";
var TYPE_PAIR = "kdeconnect.pair";


/**
 * Packets
 */
var Packet = new Lang.Class({
    Name: "GSConnectPacket",
    Extends: GObject.Object,

    _init: function (data=false) {
        this.parent();

        this.id = 0;
        this.type = "";
        this.body = {};

        if (data === false) {
            return;
        } else if (typeof data === "string") {
            this.fromData(data);
        } else if (typeof data === "object") {
            this.fromPacket(data);
        } else {
            log("Error: unsupported packet source: " + typeof data);
        }
    },

    _check: function (obj) {
        if (!obj.hasOwnProperty("type")) {
            debug("Packet: missing 'type' field");
            return false;
        } else if (!obj.hasOwnProperty("body")) {
            debug("Packet: missing 'body' field");
            return false;
        } else if (!obj.hasOwnProperty("id")) {
            debug("Packet: missing 'id' field");
            return false;
        }

        return true;
    },

    fromData: function (data) {
        let json;

        try {
            json = JSON.parse(data);
        } catch (e) {
            log(e);
            log("Data: '%s'".format(data));
            return;
        }

        if (this._check(json)) {
            Object.assign(this, json);
        } else {
            throw Error("Packet.fromData(): Malformed packet");
        }
    },

    // TODO: better merging than this
    fromPacket: function (packet) {
        if (this._check(packet)) {
            Object.assign(this, JSON.parse(JSON.stringify(packet)));
        } else {
            throw Error("Packet.fromPacket(): Malformed packet");
        }
    },

    toData: function () {
        this.id = Date.now();
        return JSON.stringify(this) + "\n";
    },

    toString: function () {
        return JSON.stringify(this);
    }
});


/**
 * LanChannelService consists of two parts.
 *
 * The TCP Listener listens on a port (usually 1716) and constructs a Channel
 * object from the incoming Gio.TcpConnection, emitting 'channel::'.
 *
 * The UDP Listener listens on a port (usually 1716) for incoming JSON identity
 * packets containing a TCP port for connection, taking the address from the
 * sender, emitting 'packet::'. It also broadcasts these packets to 255.255.255.255.
 */
var LanChannelService = new Lang.Class({
    Name: "GSConnectLanChannelService",
    Extends: GObject.Object,
    Properties: {
        "discovering": GObject.ParamSpec.boolean(
            "discovering",
            "ServiceDiscovering",
            "Whether the TCP Listener is active",
            GObject.ParamFlags.READWRITE,
            true
        ),
        "port": GObject.ParamSpec.uint(
            "port",
            "TCP Port",
            "The TCP port number the service is listening on",
            GObject.ParamFlags.READABLE,
            0, 1764,
            1716
        )
    },
    Signals: {
        "channel": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        },
        "packet": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },

    _init: function (port=1716) {
        this.parent();

        this._initTcpListener();
        this._initUdpListener();
    },

    get discovering() {
        return this._tcp.active;
    },

    set discovering(bool) {
        (bool) ? this._tcp.start() : this._tcp.stop();
    },

    get port() {
        return this._port || 0;
    },

    _initTcpListener: function () {
        this._tcp = new Gio.SocketService();
        let port = 1716;

        while (true) {
            try {
                this._tcp.add_inet_port(port, null);
            } catch (e) {
                debug("TcpListener: failed to bind to port " + port + ": " + e);

                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    this.destroy();
                    throw Error("TcpListener: Unable to find open port");
                }
            }

            if (this._tcp.active) {
                this._port = port;
                break;
            }
        }

        this._tcp.connect("incoming", (l, c) => this._receiveChannel(l, c));
        this._tcp.connect("notify::active", () => this.notify("discovering"));

        debug("Using port " + port + " for TCP");
    },

    /**
     * Receive a TCP connection and emit a Channel with 'channel::'
     */
    _receiveChannel: function (listener, connection) {
        let channel = new Channel();
        let _tmp = channel.connect("connected", (channel) => {
            channel.disconnect(_tmp);
            this.emit("channel", channel);
        });
        channel.accept(connection);
    },

    _initUdpListener: function () {
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
                debug("UdpListener: failed to bind to port " + port + ": " + e);

                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    this._udp.close();
                    throw Error("UdpListener: Unable to find open port");
                }
            }

            break;
        }

        // Broadcast Address
        this._udp_address = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string("255.255.255.255"),
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
        source.set_callback(() => this._receivePacket());
        source.attach(null);

        debug("Using port " + port + " for UDP");
    },

    /**
     * Receive an identity packet and emit 'packet::'
     * @param {Packet} identity - the identity packet to broadcast
     */
    _receivePacket: function () {
        let addr, data, flags, size;

        try {
            // "Peek" the incoming address
            [size, addr, data, flags] = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._input_stream.read_line(null);
        } catch (e) {
            log("Error reading UDP packet: " + e);
            return;
        }

        let packet = new Packet(data.toString());

        if (packet.type !== TYPE_IDENTITY) {
            debug("Unexpected UDP packet type: " + packet.type);
            return true;
        }

        // Save the remote address for reconnecting
        packet.body.tcpHost = addr.address.to_string();

        this.emit("packet", packet);

        return true;
    },

    /**
     * Broadcast an identity packet
     * @param {Packet} identity - the identity packet to broadcast
     */
    broadcast: function (identity) {
        //debug(packet);

        try {
            this._udp.send_to(this._udp_address, identity.toData(), null);
        } catch (e) {
            debug(e);
            log("Error sending identity packet: " + e.message);
        }
    },

    destroy: function () {
        this._tcp.stop();
        this._tcp.close();
        this._udp.close();
    }
});


var BluetoothChannelService = new Lang.Class({
    Name: "GSConnectBluetoothChannelService",
    Extends: GObject.Object,
    Properties: {
        "discovering": GObject.ParamSpec.boolean(
            "discovering",
            "ServiceDiscovering",
            "Whether the Bluetooth Listener is active",
            GObject.ParamFlags.READWRITE,
            true
        )
    },
    Signals: {
        "channel": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        },
        "packet": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
});


/**
 * Data Channels
 */
var Channel = new Lang.Class({
    Name: "GSConnectChannel",
    Extends: GObject.Object,
    Signals: {
        "connected": {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        "disconnected": {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    Properties: {
        "certificate": GObject.ParamSpec.object(
            "certificate",
            "TlsCertificate",
            "The TLS Certificate for this connection",
            GObject.ParamFlags.READABLE,
            GObject.Object
        )
    },

    _init: function (deviceId) {
        this.parent();

        this.daemon = Gio.Application.get_default();

        // We need this to lookup the certificate in GSettings
        this.identity = { body: { deviceId: deviceId } };

        this._monitor = 0;
    },

    get certificate() {
        return this._certificate || null;
    },

    /**
     * Set TCP socket options
     */
    _initSocket: function (connection) {
        return new Promise((resolve, reject) => {
            connection.socket.set_keepalive(true);
            // TCP_KEEPIDLE: time to start sending keepalive packets (seconds)
            connection.socket.set_option(6, 4, 10);
            // TCP_KEEPINTVL: interval between keepalive packets (seconds)
            connection.socket.set_option(6, 5, 5);
            // TCP_KEEPCNT: number of missed keepalive packets before disconnecting
            connection.socket.set_option(6, 6, 3);

            resolve(connection);
        });
    },

    /**
     * Read the identity packet from the Gio.SocketConnection file descriptor
     */
    _receiveIdent: function (connection) {
        return new Promise((resolve, reject) => {
            let _input_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
                    fd: connection.socket.fd,
                    close_fd: false // We're going to re-use the socket
                })
            });
            let [data, len] = _input_stream.read_line(null);
            _input_stream.close(null);

            //
            this.identity = new Packet(data.toString());
            // Save the remote address for reconnecting later
            this.identity.body.tcpHost = connection.socket.remote_address.address.to_string();
            // Can't use the remote port for reconnecting so use the default
            this.identity.body.tcpPort = 1716;

            resolve(connection);
        });
    },

    /**
     * Write our identity packet to the Gio.SocketConnection file descriptor
     */
    _sendIdent: function (connection) {
        return new Promise((resolve, reject) => {
            let _output_stream = new Gio.DataOutputStream({
                base_stream: new Gio.UnixOutputStream({
                    fd: connection.socket.fd,
                    close_fd: false // We're going to re-use the socket
                })
            });
            _output_stream.put_string(this.daemon.identity.toData(), null);
            _output_stream.close(null);

            resolve(connection);
        });
    },

    /**
     * Verify connection certificate
     */
    _onAcceptCertificate: function (connection, peer_cert, flags) {
        log("Authenticating '" + this.identity.body.deviceId + "'");

        this._certificate = peer_cert;

        // Get the settings for this deviceId
        let settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(gsconnect.app_id + ".Device", true),
            path: gsconnect.settings.path + "device/" + this.identity.body.deviceId + "/"
        });

        // If this device is paired, verify the connection certificate
        if (settings.get_string("certificate-pem")) {
            let cert = Gio.TlsCertificate.new_from_pem(
                settings.get_string("certificate-pem"),
                -1
            );

            return (cert.verify(null, peer_cert) === 0);
        }

        // Otherwise trust on first use, we pair later
        return true;
    },

    /**
     * Handshake Gio.TlsConnection
     */
    _handshakeTls: function (connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = 0;
            connection.authentication_mode = 1;
            connection.connect(
                "accept-certificate",
                this._onAcceptCertificate.bind(this)
            );

            connection.handshake_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (connection, res) => {
                    try {
                        if (connection.handshake_finish(res)) {
                            resolve(connection);
                        }
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    },

    /**
     * Wrap @connection in TlsClientConnection and handshake
     */
    _clientTls: function (connection) {
        return new Promise((resolve, reject) => {
            connection = Gio.TlsClientConnection.new(
                connection,
                connection.socket.remote_address // TODO: incompatible wiht bluez?
            );
            connection.set_certificate(this.daemon.certificate);

            resolve(this._handshakeTls(connection));
        });
    },

    /**
     * Wrap @connection in TlsServerConnection and handshake
     */
    _serverTls: function (connection) {
        return new Promise((resolve, reject) => {
            connection = Gio.TlsServerConnection.new(
                connection,
                this.daemon.certificate
            );

            resolve(this._handshakeTls(connection));
        });
    },

    /**
     * Init streams for reading/writing packets and monitor the input stream
     * TODO
     */
    _initPacketIO: function (connection) {
        return new Promise((resolve, reject) => {
            this._input_stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                newline_type: Gio.DataStreamNewlineType.LF
            });

            this._output_stream = new Gio.DataOutputStream({
                base_stream: connection.output_stream
            });

            this._monitor = this._input_stream.base_stream.create_source(null);
            this._monitor.set_callback((condition) => {
                let result = this.receive();
                if (!result) { this.close(); }
                return result;
            });
            this._monitor.attach(null);

            resolve(connection);
        });
    },

    /**
     * Open a channel (outgoing connection)
     * @param {Gio.InetSocketAddress} address - ...
     */
    open: function (address) {
        log("Connecting to '" + this.identity.body.deviceId + "'");

        // Open a new outgoing connection
        return new Promise((resolve, reject) => {
            let client = new Gio.SocketClient();

            client.connect_async(address, null, (client, res) => {
                try {
                    let connection = client.connect_finish(res);
                    resolve(connection); // FIXME
                } catch (e) {
                    debug(e);
                    log("Error connecting: " + e);
                    this.close();
                    reject(e)
                }
            });
        // Set the usual socket options
        }).then(tcpConnection => {
            return this._initSocket(tcpConnection);
        // Send our identity packet
        }).then(tcpConnection => {
            return this._sendIdent(tcpConnection);
        // Authenticate the connection
        }).then(tcpConnection => {
            return this._serverTls(tcpConnection);
        // Store the certificate and init streams for packet exchange
        }).then(tlsConnection => {
            this._certificate = tlsConnection.get_peer_certificate();
            return this._initPacketIO(tlsConnection);
        // Set the connection and emit
        }).then(tlsConnection => {
            this._connection = tlsConnection;
            this.emit("connected");
        }).catch(e => {
            debug(e);
            log("Error opening connection: " + e.message);
            this.close();
        });
    },

    /**
     * Accept a channel (incoming connection)
     * @param {Gio.Socket} connection - ...
     */
    accept: function (connection) {
        // Set the usual socket options and receive the device's identity
        return this._initSocket(connection).then(tcpConnection => {
            return this._receiveIdent(tcpConnection);
        // Authenticate the connection
        }).then(tcpConnection => {
            return this._clientTls(tcpConnection);
        // Store the certificate and init streams for packet exchange
        }).then(tlsConnection => {
            this._certificate = tlsConnection.get_peer_certificate();
            return this._initPacketIO(tlsConnection);
        // Set the connection and emit
        }).then(tlsConnection => {
            this._connection = tlsConnection;
            this.emit("connected");
        }).catch(e => {
            log("Error accepting connection: " + e.message);
            this.close();
            return e;
        });
    },

    close: function () {
        try {
            if (this._monitor > 0) {
                GLib.Source.remove(this._monitor);
                this._monitor = 0;
            }
        } catch (e) {
            debug(e);
            log("error removing monitor: " + e);
        }

        ["input_stream", "output_stream", "_connection", "_listener"].map(stream => {
            try {
                if (this[stream]) {
                    this[stream].close(null);
                    delete this[stream];
                }
            } catch (e) {
                debug(e);
                log("error closing stream '" + stream + "': " + e);
            }
        });

        this.emit("disconnected");
    },

    /**
     * Send a packet to a device
     * @param {Packet} packet - A packet object
     */
    send: function (packet) {
        debug(this.identity.body.deviceId + ", " + packet.toString());

        try {
            this._output_stream.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },

    /**
     * Receive a packet from a device, emitting 'received::' with the packet
     */
    receive: function () {
        let data, len;

        try {
            [data, len] = this._input_stream.read_line(null);
        } catch (e) {
            debug(e);
            return false;
        }

        if (data === null || data === undefined || !data.length) {
            return false;
        }

        debug(this.identity.body.deviceId + ": " + data.toString());

        let packet = new Packet(data.toString());
        this.emit("received", packet);

        return true;
    }
});


/**
 * File Transfers
 *
 * Example Contruction:
 *  let transfer = new Protocol.Transfer({
 *      device: {Device.Device},
 *      size: {Number} size in bytes,
 *      input_stream: {Gio.InputStream} readable stream for uploads,
 *      output_stream: {Gio.OutputStream} writable stream for downloads
 *  });
 */
var Transfer = new Lang.Class({
    Name: "GSConnectTransfer",
    Extends: Channel,
    Signals: {
        "started": {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        "progress": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_INT ]
        },
        "cancelled": {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        "failed": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        },
        "succeeded": {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    },
    Properties: {
        "size": GObject.ParamSpec.uint(
            "size",
            "TransferSize",
            "The size in bytes of the transfer",
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32,
            0
        ),
        "uuid": GObject.ParamSpec.string(
            "uuid",
            "TransferUUID",
            "The UUID of this transfer",
            GObject.ParamFlags.READABLE,
            ""
        )
    },

    _init: function (params) {
        this.parent(params.device.id);

        this._cancellable = new Gio.Cancellable();

        this.device = params.device;

        this._input_stream = params.input_stream;
        this._output_stream = params.output_stream;
        this._size = params.size;

        this.checksum = params.checksum;
        this._checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
        this._written = 0;
    },

    get size() {
        return this._size || 0;
    },

    get uuid() {
        if (!this._uuid) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    },

    /**
     * Open a new channel for uploading (incoming connection)
     * @param {Number} port - A port between 1739-1764 for uploading
     *
     * Example usage:
     *  transfer.connect("connected", transfer => transfer.start());
     *  transfer.connect("succeeded"|"failed"|"cancelled", transfer => transfer.close());
     *  transfer.upload().then(port => {
     *      let packet = new Protocol.Packet({
     *          id: 0,
     *          type: "kdeconnect.share.request",
     *          body: { filename: file.get_basename() },
     *          payloadSize: info.get_size(),
     *          payloadTransferInfo: { port: port }
     *      });
     *
     *      device._channel.send(packet);
     *  });
     */
    upload: function (port=1739) {
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
                        reject(new Error("Failed to open port"));
                    }
                }

                break;
            }

            // Wait for an incoming connection
            this._listener.accept_async(null, this.upload_accept.bind(this));

            // Return the incoming port for payloadTransferInfo
            resolve(port);
        });
    },

    upload_accept: function (listener, res) {
        debug(this.identity.body.deviceId);

        // Accept the connection
        return new Promise((resolve, reject) => {
            let connection, src;

            try {
                [connection, src] = this._listener.accept_finish(res);
                resolve(connection);
            } catch (e) {
                reject(e);
            }
        // Set the usual socket options
        }).then(tcpConnection => {
            return this._initSocket(tcpConnection);
        // Authenticate the connection
        }).then(tcpConnection => {
            return this._serverTls(tcpConnection);
        // Init streams for uploading, set the connection and emit
        }).then(tlsConnection => {
            this._output_stream = tlsConnection.get_output_stream();
            this._connection = tlsConnection;
            this.emit("connected");
        }).catch(e => {
            debug(e);
            log("Error uploading: " + e.message);
            this.close();
        });
    },

    /**
     * Open a new channel for downloading (outgoing connection)
     * @param {Number} port - The port to connect to
     *
     * Example usage:
     *  transfer.connect("connected", transfer => transfer.start());
     *  transfer.connect("succeeded"|"failed"|"cancelled", transfer => transfer.close());
     *  transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
     */
    download: function (port) {
        log("Connecting to '" + this.identity.body.deviceId + "'");

        // Create a new connection
        return new Promise((resolve, reject) => {
            let client = new Gio.SocketClient();

            // Use @port and the address from GSettings
            let address = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.settings.get_string("tcp-host")
                ),
                port: port
            });

            // Connect
            client.connect_async(address, null, (client, res) => {
                try {
                    resolve(client.connect_finish(res));
                } catch (e) {
                    reject(e)
                }
            });
        // Set the usual socket options
        }).then(tcpConnection => {
            return this._initSocket(tcpConnection);
        // Authenticate the connection
        }).then(tcpConnection => {
            return this._clientTls(tcpConnection);
        // Init streams for downloading, set the connection and emit
        }).then(tlsConnection => {
            this._input_stream = tlsConnection.get_input_stream();
            this._connection = tlsConnection;
            this.emit("connected");
        }).catch(e => {
            debug(e);
            log("Error downloading: " + e.message);
            this.close();
        });
    },

    start: function () {
        this.emit("started");
        this._read();
    },

    cancel: function () {
        this._cancellable.cancel();
        this.emit("cancelled");
    },

    _read: function () {
        if (this._cancellable.is_cancelled()) { return; }

        this._input_stream.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                let bytes;

                try {
                    bytes = source.read_bytes_finish(res);
                } catch (e) {
                    debug(e);
                    this.emit("failed", e.message);
                    return;
                }

                // Data to write
                if (bytes.get_size()) {
                    this._write(bytes);
                    this._checksum.update(bytes.unref_to_array());
                // Expected more data
                } else if (this.size > this._written) {
                    this.emit("failed", "Incomplete transfer");
                // Data should match the checksum
                } else if (this.checksum) {
                    if (this.checksum !== this._checksum.get_string()) {
                        this.emit("failed", "Checksum mismatch");
                    } else {
                        debug("Completed transfer of " + this.size + " bytes");
                        this.emit("succeeded");
                    }
                // All done
                } else {
                    debug("Completed transfer of " + this.size + " bytes");
                    this.emit("succeeded");
                }
            }
        );
    },

    _write: function (bytes) {
        if (this._cancellable.is_cancelled()) { return; }

        this._output_stream.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                try {
                    this._written += source.write_bytes_finish(res);
                } catch (e) {
                    debug(e);
                    this.emit("failed", e.message);
                    return;
                }

                this.emit("progress", (this._written / this.size) * 100);
                this._read();
            }
        );
    }
});

