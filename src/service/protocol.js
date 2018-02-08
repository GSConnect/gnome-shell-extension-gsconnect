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
 * Listeners
 */
var TcpListener = new Lang.Class({
    Name: "GSConnectTcpListener",
    Extends: Gio.SocketService,

    _init: function (port=1716) {
        this.parent();

        while (true) {
            try {
                this.add_inet_port(port, null);
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

            if (this.active) {
                this._port = port;
                break;
            }
        }

        log("TcpListener: using port " + this._port);
    },

    destroy: function () {
        this.stop();
        this.close();
    }
});


var UdpListener = new Lang.Class({
    Name: "GSConnectUdpListener",
    Extends: GObject.Object,
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },

    _init: function (port=1716) {
        this.parent();

        this.socket = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        this.socket.init(null);

        while (true) {
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: port
            });

            try {
                this.socket.bind(addr, false);
            } catch (e) {
                debug("UdpListener: failed to bind to port " + port + ": " + e);

                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    this.socket.close();
                    throw Error("UdpListener: Unable to find open port");
                }
            }

            break;
        }

        // Broadcast Address
        this._broadcastAddr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string("255.255.255.255"),
            port: this.socket.local_address.port
        });

        this._input_stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this.socket.fd,
                close_fd: false
            })
        });

        // Watch for incoming packets
        let source = this.socket.create_source(GLib.IOCondition.IN, null);
        source.set_callback(Lang.bind(this, this.receive));
        source.attach(null);

        log("UdpListener: using port " + port);
    },

    send: function (packet) {
        debug("UdpListener.send()");

        this.socket.send_to(
            this._broadcastAddr,
            packet.toData(),
            null
        );
    },

    receive: function () {
        debug("UdpListener.receive()");

        let addr, data, flags, size;

        try {
            // "Peek" the incoming address
            [size, addr, data, flags] = this.socket.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            );
            [data, size] = this._input_stream.read_line(null);
        } catch (e) {
            log("UdpListener: Error reading data: " + e);
            return;
        }

        let packet = new Packet(data.toString());

        if (packet.type !== TYPE_IDENTITY) {
            debug("UdpListener: Unexpected packet type: " + packet.type);
            return true;
        }

        packet.body.tcpHost = addr.address.to_string();

        this.emit("received", packet);

        return true;
    },

    destroy: function () {
        try {
            if (this._input_stream !== null) {
                this._input_stream.close(null);
            }
        } catch (e) {
            log("error closing data input: " + e);
        }

        try {
            if (this.socket !== null) {
                this.socket.close();
            }
        } catch (e) {
            log("error closing UDP listener: " + e);
        }
    }
});


/**
 * Data Channels
 */
var LanChannel = new Lang.Class({
    Name: "GSConnectLanChannel",
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

    _init: function (deviceId) {
        this.parent();

        this.daemon = Gio.Application.get_default();
        this.identity = { body: { deviceId: deviceId } };

        this._monitor = 0;
    },

    // Set socket options
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

    // Receive an identity packet
    _receiveIdent: function (connection) {
        return new Promise((resolve, reject) => {
            let _input_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
                    fd: connection.socket.fd,
                    close_fd: false // We're going to re-use the socket
                })
            });
            let [data, len] = _input_stream.read_line(null);
            this.identity = new Packet(data.toString());
            this.identity.body.tcpHost = connection.socket.remote_address.address.to_string();
            // We can't use the remote port later so use a reasonable default
            this.identity.body.tcpPort = 1716;
            _input_stream.close(null);

            resolve(connection);
        });
    },

    // Send identity packet, indicating we're about ready for a handshake
    _sendIdent: function (connection) {
        return new Promise((resolve, reject) => {
            let _output_stream = new Gio.DataOutputStream({
                base_stream: new Gio.UnixOutputStream({
                    fd: connection.socket.fd,
                    close_fd: false
                })
            });
            _output_stream.put_string(this.daemon.identity.toData(), null);
            _output_stream.close(null);

            resolve(connection);
        });
    },

    // Wrap connection in TlsClientConnection and handshake
    _clientTls: function (connection) {
        return new Promise((resolve, reject) => {
            connection = Gio.TlsClientConnection.new(
                connection,
                connection.socket.remote_address
            );
            connection.set_certificate(this.daemon.certificate);
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

    // Wrap connection in TlsServerConnection and handshake
    _serverTls: function (connection) {
        return new Promise((resolve, reject) => {
            connection = Gio.TlsServerConnection.new(
                connection,
                this.daemon.certificate
            );
            connection.set_certificate(this.daemon.certificate);
            connection.validation_flags = 0;
            connection.authentication_mode = 1;

            connection.connect(
                "accept-certificate",
                this._onAcceptCertificate.bind(this)
                //Lang.bind(this, this._accept_certificate)
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
     * Verify connection certificate
     */
    _onAcceptCertificate: function (conn, peer_cert, flags) {
        log("Authenticating '" + this.identity.body.deviceId + "'");

        this._peer_cert = peer_cert;

        // Get the settings for this deviceId
        let settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(gsconnect.app_id + ".Device", true),
            path: gsconnect.settings.path + "device/" + this.identity.body.deviceId + "/"
        });

        // If we have a certificate, verify the connection
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
        }).then(result => {
            return this._initSocket(result);
        // Send our identity packet
        }).then(result => {
            return this._sendIdent(result);
        // Authenticate the connection
        }).then(result => {
            return this._serverTls(result);
        // Store the certificate and init streams for packet exchange
        }).then(result => {
            this._peer_cert = result.get_peer_certificate();
            return this._initPacketIO(result);
        // Set the connection and emit
        }).then(result => {
            this._connection = result;
            this.emit("connected");
        }).catch(e => {
            debug(e);
            log("Error connecting: " + e);
            this.close();
        });
    },

    /**
     * Accept a channel (incoming connection)
     * @param {Gio.Socket} connection - ...
     */
    accept: function (connection) {
        // Set the usual socket options and receive the device's identity
        return this._initSocket(connection).then(result => {
            return this._receiveIdent(result);
        // Authenticate the connection
        }).then(result => {
            return this._clientTls(result);
        // Store the certificate and init streams for packet exchange
        }).then(result => {
            this._peer_cert = result.get_peer_certificate();
            return this._initPacketIO(result);
        // Set the connection and emit
        }).then(result => {
            this._connection = result;
            this.emit("connected");
        }).catch(e => {
            log("Error connecting: " + e);
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

        ["_input_stream", "_output_stream", "_connection", "_listener"].map(stream => {
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

    send: function (packet) {
        debug(this.identity.body.deviceId + ", " + packet.toString());

        try {
            this._output_stream.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },

    receive: function () {
        let data, len, packet;

        try {
            [data, len] = this._input_stream.read_line(null);
        } catch (e) {
            log("Failed to receive packet from " + this.identity.body.deviceId + ": " + e);
            return false;
        }

        if (data === null || data === undefined || !data.length) {
            return false;
        }

        debug(this.identity.body.deviceId + ": " + data.toString());

        packet = new Packet(data.toString());
        this.emit("received", packet);
        return true;
    }
});


/**
 * File Transfers
 * TODO: errors
 */
var Transfer = new Lang.Class({
    Name: "GSConnectTransfer",
    Extends: LanChannel,
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

        this.size = params.size;
        this.checksum = params.checksum;
        this._checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
        this.written = 0;
    },

    get uuid() {
        if (!this._uuid) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    },

    /**
     * Open a new channel for uploading (incoming connection)
     * @param {Gio.Socket} connection - ...
     */
    upload: function (port=1739) {
        debug(this.identity.body.deviceId);

        return new Promise((resolve, reject) => {
            // Start listening on new socket on a port between 1739-1764
            let listener = new Gio.SocketListener();

            while (true) {
                try {
                    listener.add_inet_port(port, null);
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
            listener.accept_async(null, this.upload_accept.bind(this));

            // Return the incoming port for payloadTransferInfo
            resolve(port);
        });
    },

    upload_accept: function (listener, res) {
        debug(this.identity.body.deviceId);

        return new Promise((resolve, reject) => {
            this._listener = listener;

            // Accept the connection
            let connection, src;

            try {
                [connection, src] = this._listener.accept_finish(res);
            } catch (e) {
                debug(e);
                this.close();
                reject(e);
            }

            // Set the usual socket options and authenticate the connection
            return this._initSocket(connection).then(result => {
                return this._serverTls(result);
            // Init streams for uploading, set the connection and emit
            }).then(result => {
                this._output_stream = result.get_output_stream();
                this._connection = result;
                this.emit("connected");
            }).catch(e => {
                debug(e);
            });
        });
    },

    /**
     * Open a new channel for downloading (outgoing connection)
     */
    download: function (port) {
        log("Connecting to '" + this.identity.body.deviceId + "'");

        return new Promise((resolve, reject) => {
            let address = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.settings.get_string("tcp-host")
                ),
                port: port
            });

            // Create a new connection
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
        }).then(result => {
            return this._initSocket(result);
        // Authenticate the connection
        }).then(result => {
            return this._clientTls(result);
        // Init streams for packet exchange, set the connection and emit
        }).then(result => {
            this._input_stream = result.get_input_stream();
            this._connection = result;
            this.emit("connected");

            return true;
        }).catch(e => {
            debug(e);
            log("Error connecting: " + e);
            this.close();
        });
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
                } else if (this.size > this.written) {
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
                    this.written += source.write_bytes_finish(res);
                } catch (e) {
                    debug(e);
                    this.emit("failed", e.message);
                    return;
                }

                this.emit("progress", (this.written / this.size) * 100);
                this._read();
            }
        );
    },

    start: function () {
        this.emit("started");
        this._read();
    },

    cancel: function () {
        this._cancellable.cancel();
        this.emit("cancelled");
    }
});

