"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


// Packet Types
var TYPE_IDENTITY = "kdeconnect.identity";
var TYPE_PAIR = "kdeconnect.pair";

// Port Ranges
var MIN_TCP_PORT = 1716;
var MAX_TCP_PORT = 1764;

var TcpPort = {
    MIN: 1716,
    MAX: 1764
};

var TransferPort = {
    MIN: 1739,
    MAX: 1764
};


/**
 * Packets
 */
var Packet = new Lang.Class({
    Name: "GSConnectPacket",
    Extends: GObject.Object,
    
    _init: function (data=false) {
        this.parent();
        
        this.id = Date.now();
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
            Common.debug("Packet: missing 'type' field");
            return false;
        } else if (!obj.hasOwnProperty("body")) {
            Common.debug("Packet: missing 'body' field");
            return false;
        } else if (!obj.hasOwnProperty("id")) {
            Common.debug("Packet: missing 'id' field");
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
    
    fromPacket: function (packet) {
        if (this._check(packet)) {
            Object.assign(this, {
                id: Date.now(),
                type: packet.type,
                body: JSON.parse(JSON.stringify(packet.body))
            });
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

// TODO TODO TODO
var TcpListener = new Lang.Class({
    Name: "GSConnectTcpListener",
    Extends: GObject.Object,
    Signals: {
        "listening": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    
    _init: function (port=TcpPort.MIN) {
        this.parent();
        
        this.service = new Gio.SocketService();
        
        while (true) {
            try {
                this.service.add_inet_port(port, null);
            } catch (e) {
                Common.debug("TcpListener: failed to bind to port " + port + ": " + e);
                
                if (port < TcpPort.MAX) {
                    port += 1;
                    continue;
                } else {
                    this.service.stop();
                    throw Error("TcpListener: Unable to open port");
                }
            }
            
            if (this.service.active) {
                break;
            }
        }
        
        this.service.connect("incoming", (service, connection, source) => {
            Common.debug("ADDR: " + connection.socket.remote_address.address.to_string());
            
            this.emit("received", connection);
        });
        
        this.emit("listening");
    },
    
    destroy: function () {
        this.service.stop();
    }
});


var UdpListener = new Lang.Class({
    Name: "GSConnectUdpListener",
    Extends: GObject.Object,
    Signals: {
        "listening": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    
    _init: function (port=TcpPort.MIN) {
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
                Common.debug("UdpListener: failed to bind to port " + port + ": " + e);
                
                if (port < TcpPort.MAX) {
                    port += 1;
                    continue;
                } else {
                    this.socket.close();
                    throw Error("UdpListener: Unable to bind socket");
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
            base_stream: new Gio.UnixInputStream({ fd: this.socket.fd })
        });
        
        // Watch for incoming packets
        let source = this.socket.create_source(GLib.IOCondition.IN, null);
        source.set_callback(Lang.bind(this, this.receive));
        source.attach(null);
        
        this.emit("listening");
        
        log("listening for new devices on 0.0.0.0:" + port);
    },
    
    send: function (packet) {
        Common.debug("UdpListener.send()");
        
        this.socket.send_to(
            this._broadcastAddr,
            packet.toData(),
            null
        );
    },
    
    receive: function () {
        Common.debug("UdpListener.receive()");
        
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
            log("Daemon: Error reading data: " + e);
            return;
        }
        
        let packet = new Packet(data.toString());
        
        if (packet.type !== TYPE_IDENTITY) {
            Common.debug("UDP Listener: Unexpected packet type: " + packet.type);
            return true;
        } else {
            Common.debug("UDP Listener received: " + data);
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
                this.socket.close(null);
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
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "disconnected": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    
    _init: function (daemon, identity=null) {
        this.parent();
        
        this.daemon = daemon;
        this.identity = identity;
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
        log("PORT: " + this._connection.socket.remote_address.port);
        log("PORT: " + this._connection.socket.local_address.port);
        
        this.identity.body.tcpPort = this._connection.socket.local_address.port;
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
        log("Authenticating '" + this.identity.body.deviceName + "'");
        log("PEER CERT: '" + peer_cert + "'");
        this._peer_cert = peer_cert;
        let cert = Common.getCertificate(this.identity.body.deviceId);
        
        if (cert) {
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
        log("Connecting to '" + this.identity.body.deviceName + "'");
        
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
        log("Authenticating '" + this.identity.body.deviceName + "'");
        
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
            if (this._monitor) {
                if (this._monitor > 0) {
                    GLib.Source.remove(this._monitor);
                    delete this._monitor;
                }
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
                this._listener.close(null);
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
        Common.debug("LanChannel.send(" + packet.toString() + ")");
    
        try {
            this._out.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },
    
    receive: function () {
        Common.debug("LanChannel.receive(" + this.identity.body.deviceName + ")");
        
        let data, len, packet;
        
        try {
            [data, len] = this._in.read_line(null);
            Common.debug("Device received: " + data);
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
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "progress": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_INT ]
        },
        "cancelled": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "failed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "succeeded": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (srcStream, destStream, size) {
        this.parent();
        
        this._in = srcStream;
        this._out = destStream;
        this._cancellable = new Gio.Cancellable();
        
        this.id = GLib.uuid_string_random();
        this.size = size;
        this.bytesWritten = 0;
    },
    
    _read: function () {
        Common.debug("Transfer: _read()");
        
        if (this._cancellable.is_cancelled()) { return; }
        
        this._in.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                let bytes = source.read_bytes_finish(res);
                
                if (bytes.get_size()) {
                    this._write(bytes);
                } else {
                    
                    // FIXME: better
                    if (this.bytesWritten < this.size) {
                        this.emit("failed", "Failed to complete transfer");
                    } else {
                        this.emit("succeeded");
                        log("Completed transfer of " + this.size + " bytes");
                    }
                }
            }
        );
    },
    
    _write: function (bytes) {
        Common.debug("LanChannel: _write()");
        
        if (this._cancellable.is_cancelled()) { return; }
        
        this._out.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                this.bytesWritten += source.write_bytes_finish(res);
                this.emit("progress", (this.bytesWritten / this.size) * 100);
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
    
    _init: function (device, fileStream) {
        this.parent(device);
        
        this._out = fileStream;
    },
    
    auth: function (client, res) {
        try {
            this._connection = client.connect_finish(res);
            this._initSocket();
            this._initTls(true);
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },
    
    opened: function (connection, res) {
        Common.debug("TransferChannel.opened(" + this.device.id + ")");
        
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
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device, srcStream) {
        this.parent(device);
        
        this._in = srcStream;
    },
    
    open: function (port=1739) {
        this._listener = new Gio.SocketListener();
        
        while (true) {
            try {
                this._listener.add_inet_port(port, null);
            } catch (e) {
                if (port < TransferPort.MAX) {
                    port += 1;
                    continue;
                } else {
                    throw Error("Failed to open port");
                }
            }
            
            this._port = port;
            
            break;
        }
        
        this._listener.accept_async(null, Lang.bind(this, this.auth));
        
        this.emit("listening");
    },
    
    auth: function (listener, res) {
        Common.debug("TransferChannel.opened(" + this.identity.body.deviceName + ")");
        
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


