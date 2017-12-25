"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;


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

        this._in = new Gio.DataInputStream({
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
            [data, size] = this._in.read_line(null);
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
            if (this._in !== null) {
                this._in.close(null);
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

    _init: function (daemon, deviceId) {
        this.parent();

        this.daemon = daemon;
        this.identity = { body: { deviceId: deviceId } };

        this._monitor = 0;
    },

    // Receive an identity packet
    _receiveIdent: function () {
        let _in = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this._connection.socket.fd,
                close_fd: false
            })
        });
        let [data, len] = _in.read_line(null);
        this.identity = new Packet(data.toString());
        this.identity.body.tcpHost = this._connection.socket.remote_address.address.to_string();
        // We can't use the remote port later so use a reasonable default
        this.identity.body.tcpPort = 1716;
        _in.close(null);
    },

    // Send identity packet, indicating we're about ready for a handshake
    _sendIdent: function () {
        let _out = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({
                fd: this._connection.socket.fd,
                close_fd: false
            })
        });
        _out.put_string(this.daemon.identity.toData(), null);
        _out.close(null);
    },

    // Set socket options
    _initSocket: function () {
        this._connection.socket.set_keepalive(true);
        // TCP_KEEPIDLE: time to start sending keepalive packets (seconds)
        this._connection.socket.set_option(6, 4, 10);
        // TCP_KEEPINTVL: interval between keepalive packets (seconds)
        this._connection.socket.set_option(6, 5, 5);
        // TCP_KEEPCNT: number of missed keepalive packets before disconnecting
        this._connection.socket.set_option(6, 6, 3);
    },

    // Wrap connection in TlsServerConnection and handshake
    _initTls: function (client=false) {
        if (client) {
            this._connection = Gio.TlsClientConnection.new(
                this._connection,
                this._connection.socket.remote_address
            );
            this._connection.set_certificate(this.daemon.certificate);
        } else {
            this._connection = Gio.TlsServerConnection.new(
                this._connection,
                this.daemon.certificate
            );
        }

        this._connection.validation_flags = 0;
        this._connection.authentication_mode = 1;

        this._connection.connect(
            "accept-certificate",
            Lang.bind(this, this._accept_certificate)
        );

        this._connection.handshake_async(
            GLib.PRIORITY_DEFAULT,
            null,
            Lang.bind(this, this.opened)
        );
    },

    // Negotitate certificate/pairing
    _accept_certificate: function (conn, peer_cert, flags) {
        log("Authenticating '" + this.identity.body.deviceId + "'");

        this._peer_cert = peer_cert;

        let settings = new Gio.Settings({
            settings_schema: ext.gschema.lookup(ext.app_id + ".Device", true),
            path: ext.settings.path + "device/" + this.identity.body.deviceId + "/"
        });

        if (settings.get_string("certificate-pem")) {
            let cert = Gio.TlsCertificate.new_from_pem(
                settings.get_string("certificate-pem"),
                -1
            );

            return (cert.verify(null, peer_cert) === 0);
        }

        return true;
    },

    // Open input/output streams and monitor the input stream for packets
    _initStreams: function () {
        this._in = new Gio.DataInputStream({
            base_stream: this._connection.input_stream,
            newline_type: Gio.DataStreamNewlineType.LF
        });

        this._out = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream
        });

        this._monitor = this._in.base_stream.create_source(null);
        this._monitor.set_callback((condition) => {
            let result = this.receive();
            if (!result) { this.close(); }
            return result;
        });
        this._monitor.attach(null);

        return true;
    },

    /**
     * Public Methods
     */
    open: function (addr) {
        log("Connecting to '" + this.identity.body.deviceId + "'");

        let client = new Gio.SocketClient();
        client.connect_async(addr, null, (client, res) => {
            try {
                this._connection = client.connect_finish(res);
            } catch (e) {
                log("Error connecting: " + e);
                this.close();
                return false;
            }

            this.request(this._connection);
        });
    },

    // Request a channel (outgoing connection)
    request: function (connection) {
        this._connection = connection;

        try {
            this._initSocket();
            this._sendIdent();
            this._initTls();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },

    // Accept a channel (incoming connection)
    accept: function (connection) {
        this._connection = connection;

        try {
            this._initSocket();
            this._receiveIdent();
            this._initTls(true); // client=true
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },

    opened: function (connection, res) {
        try {
            this._connection.handshake_finish(res);
            // FIXME: check if null?
            this._peer_cert = this._connection.get_peer_certificate();
            this._initStreams();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }

        this.emit("connected");
        return true;
    },

    close: function () {
        try {
            if (this._monitor > 0) {
                GLib.Source.remove(this._monitor);
                this._monitor = 0;
            }
        } catch (e) {
            log("error removing monitor: " + e);
        }

        try {
            if (this._in) {
                this._in.close(null);
            }
        } catch (e) {
            log("error closing data input: " + e);
        }

        try {
            if (this._out) {
                this._out.close(null);
            }
        } catch (e) {
            log("error closing data output: " + e);
        }

        try {
            if (this._connection) {
                this._connection.close(null);
            }
        } catch (e) {
            log("error closing connection: " + e);
        }

        try {
            if (this._listener) {
                this._listener.close();
            }
        } catch (e) {
            log("error closing listener: " + e);
        }

        delete this._in;
        delete this._out;
        delete this._connection;
        delete this._listener;

        this.emit("disconnected");
    },

    send: function (packet) {
        debug("LanChannel.send(" + this.identity.body.deviceId + ", " + packet.toString() + ")");

        try {
            this._out.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },

    receive: function () {
        debug("LanChannel.receive(" + this.identity.body.deviceId + ")");

        let data, len, packet;

        try {
            [data, len] = this._in.read_line(null);
            debug("Device received: " + data);
        } catch (e) {
            log("Failed to receive packet: " + e);
            return false;
        }

        if (data === null || data === undefined || !data.length) {
            return false;
        }

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
    Extends: GObject.Object,
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

    _init: function (channel, size, checksum) {
        this.parent();

        this.id = GLib.uuid_string_random();

        this._in = channel._in;
        this._out = channel._out;
        this._cancellable = new Gio.Cancellable();

        this.size = size;
        this.written = 0;

        this.checksum = checksum;
        this._checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
    },

    _read: function () {
        if (this._cancellable.is_cancelled()) { return; }

        this._in.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                let bytes = source.read_bytes_finish(res);

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

        this._out.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                this.written += source.write_bytes_finish(res);
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


var LanDownloadChannel = new Lang.Class({
    Name: "GSConnectLanDownloadChannel",
    Extends: LanChannel,

    _init: function (device, identity, fileStream) {
        this.parent(device, identity);

        this._out = fileStream;
    },

    request: function (connection) {
        debug("LanDownloadChannel.request(" + this.identity.body.deviceId + ")");

        this._connection = connection;

        try {
            this._initSocket();
            this._initTls(true);
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },

    opened: function (connection, res) {
        debug("LanDownloadChannel.opened(" + this.identity.body.deviceId + ")");

        try {
            this._in = this._connection.get_input_stream();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }

        this.emit("connected");
    }
});


var LanUploadChannel = new Lang.Class({
    Name: "GSConnectLanUploadChannel",
    Extends: LanChannel,
    Signals: {
        "listening": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_INT ]
        }
    },

    _init: function (device, identity, srcStream) {
        this.parent(device, identity);

        this._in = srcStream;
    },

    open: function (port=1739) {
        debug("LanUploadChannel.open(" + this.identity.body.deviceId + ")");

        this._listener = new Gio.SocketListener();

        while (true) {
            try {
                this._listener.add_inet_port(port, null);
            } catch (e) {
                if (port < 1764) {
                    port += 1;
                    continue;
                } else {
                    throw Error("Failed to open port");
                }
            }

            break;
        }

        this._listener.accept_async(null, Lang.bind(this, this.accept));

        this.emit("listening", port);
    },

    accept: function (listener, res) {
        debug("LanUploadChannel.accept(" + this.identity.body.deviceId + ")");

        try {
            let src;
            [this._connection, src] = this._listener.accept_finish(res);
            this._initSocket();
            this._initTls();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },

    opened: function (connection, res) {
        debug("LanUploadChannel.opened(" + this.identity.body.deviceId + ")");

        try {
            this._connection.handshake_finish(res);
            this._out = this._connection.get_output_stream();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }

        this.emit("connected");
    }
});

