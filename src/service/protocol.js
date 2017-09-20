"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


// Packet Types
var TYPE_IDENTITY = "kdeconnect.identity";
var TYPE_PAIR = "kdeconnect.pair";
var TYPE_ENCRYPTED = "kdeconnect.encrypted";


/**
 * Packets
 */
var Packet = new Lang.Class({
    Name: "GSConnectPacket",
    Extends: GObject.Object,
    
    _init: function (data=false) {
        // TODO
        this.parent();
        
        this.id = Date.now();
        this.type = "";
        this.body = {};
        
        if (data) {
            this.fromData(data);
        }
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
        
        if (!json.hasOwnProperty("type")) {
            throw Error("packet is missing 'type' field");
        } else if (!json.hasOwnProperty("body")) {
            throw Error("packet is missing 'body' field");
        } else if (!json.hasOwnProperty("id")) {
            throw Error("packet is missing 'id' field");
        } else {
            Object.assign(this, json);
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


var IdentityPacket = new Lang.Class({
    Name: "GSConnectIdentityPacket",
    Extends: Packet,
    
    _init: function (daemon=false) {
        this.parent();
        
        this.type = TYPE_IDENTITY;
        this.body = {
            deviceId: "",
            deviceName: "",
            deviceType: "",
            incomingCapabilities: [],
            outgoingCapabilities: [],
            tcpPort: 0,
            protocolVersion: 7
        };
        
        if (daemon) {
            this.fromDaemon(daemon);
        }
    },
    
    fromDaemon: function (daemon) {
        Object.assign(this, {
            id: Date.now(), //FIXME
            type: TYPE_IDENTITY,
            body: JSON.parse(JSON.stringify(daemon.identity.body))
        });
    }
});


var PairPacket = new Lang.Class({
    Name: "GSConnectPairPacket",
    Extends: Packet,
    
    _init: function (daemon=null) {
        this.parent();
        
        this.type = TYPE_PAIR;
        this.body = {
            pair: false,
            publicKey: ""
        };
        
        if (daemon !== null) {
            this.fromDaemon(daemon);
        }
    },
    
    fromDaemon: function (daemon) {
        // TODO
        Object.assign(this, {
            id: Date.now(), //FIXME
            type: TYPE_PAIR,
            body: {
                pair: true,
                publicKey: JSON.parse(JSON.stringify(daemon.publicKey))
            }
        });
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
    
    _init: function (device, port=null) {
        this.parent();
        this.device = device;
        this.host = device.identity.body.tcpHost;
        this.port = (port === null) ? device.identity.body.tcpPort : port;
        
        this._connection = null;
        this._in = null;
        this._out = null;
        this._monitor = 0;
        this._peer_cert = null;
    },
    
    // Send identity packet, indicating we're about ready for a handshake
    _sendIdent: function () {
        let ident = new IdentityPacket(this.device.daemon);
        let _out = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({
                fd: this._connection.socket.fd,
                close_fd: false
            })
        });
        _out.put_string(ident.toData(), null);
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
    
    // Wrap *connection* in TlsServerConnection and handshake
    _initTls: function (connection) {
        this._connection = Gio.TlsServerConnection.new(
            this._connection,
            this.device.daemon.certificate
        );
        this._connection.validation_flags = 0;
        this._connection.authentication_mode = 1;
        
        // TODO: move to discrete function and handle errors/failures
        this._connection.connect("accept-certificate", (conn, peer_cert, flags) => {
            if (this.device.paired) {
                log("verifying certificate...");
                let paired_cert = Gio.TlsCertificate.new_from_file(
                    this.device.config_cert
                );
                
                return (paired_cert.verify(null, peer_cert) === 0);
            } else {
                log("delaying certificate verification...");
                this._peer_cert = peer_cert;
                return true;
            }
        });
        
        this._connection.handshake(null);
    },
    
    // Open input/output streams
    _initStreams: function () {
        this._in = new Gio.DataInputStream({
            base_stream: this._connection.input_stream,
            newline_type: Gio.DataStreamNewlineType.LF
        });
        
        this._out = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream
        });
    },
    
    // Init a condition monitor
    _initMonitor: function () {
        // Listen for packets
        this._monitor = this._in.base_stream.create_source(null);
        this._monitor.set_callback((condition) => {
            let result = this.receive();
            if (!result) { this.emit("disconnected"); }
            return result;
        });
        this._monitor.attach(null);
        
        return true;
    },
    
    open: function () {
        log("LanChannel.open(" + this.device.id + ")");
        
        let client = new Gio.SocketClient();
        let addr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string(this.host),
            port: this.port
        });
        
        client.connect_async(addr, null, Lang.bind(this, this.opened));
    },
    
    opened: function (client, res) {
        log("LanChannel.opened(" + this.device.id + ")");
        
        try {
            this._connection = client.connect_finish(res);
            this._initSocket();
            this._sendIdent();
            this._initTls();
            this._initStreams();
            this._initMonitor();
        } catch (e) {
            log("Error connecting: " + e);
            
            this.emit("disconnected");
            return false;
        }
        
        this.emit("connected");
        
        return true;
    },
    
    close: function () {
        log("LanChannel.close(" + this.device.id + ")");
        
        if (this._monitor > 0) {
            Gio.Source.remove(this._monitor);
            this._monitor = 0;
        }
        
        try {
            if (this._in !== null) {
                this._in.close(null);
            }
        } catch (e) {
            log("error closing data input: " + e);
        }
        
        try {
            if (this._out !== null) {
                this._out.close(null);
            }
        } catch (e) {
            log("error closing data output: " + e);
        }
        
        try {
            if (this._connection !== null) {
                this._connection.close(null);
            }
        } catch (e) {
            log("error closing connection: " + e);
        }
        
        this._in = null;
        this._out = null;
        this._connection = null;
    },
    
    send: function (packet) {
        log("LanChannel.send(" + packet.toString() + ")");
    
        try {
            this._out.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },
    
    receive: function () {
        log("LanChannel.receive(" + this.device.id + ")");
        
        let data, len, packet;
        
        try {
            [data, len] = this._in.read_line(null);
        } catch (e) {
            log("Failed to receive packet: " + e);
            this.emit("disconnected");
        }
        
        if (data === null || data === undefined || !data.length) {
            return false;
        }
        
        // TODO: error checking wrt packet
        //       encrypted packets?
        packet = new Packet(data);
        this.emit("received", packet);
        
        return true;
    }
});


/**
 * File Transfers
 */
var TransferChannel = new Lang.Class({
    Name: "GSConnectTransferChannel",
    Extends: LanChannel,
    
    _init: function (device, port, srcStream=null, destStream=null) {
        this.parent(device, port);
        
        this.srcStream = srcStream;
        this.destStream = destStream;
    },
    
    _initMonitor: function () {
        // Download
        if (this.srcStream === null) {
            this.srcStream = this._in;
            this._monitor = this._in.base_stream.create_source(null);
        // Upload
        } else {
            this.destStream = this._out;
            this._monitor = this._out.base_stream.create_source(null);
        }
        // Listen for packets
        this._monitor.set_callback(Lang.bind(this, this.transfer));
        this._monitor.attach(null);
        
        return true;
    },
    
    opened: function (client, res) {
        log("TransferChannel.opened(" + this.device.id + ")");
        
        try {
            this._connection = client.connect_finish(res);
            log("connected");
            //this._initSocket();
            this._connection.socket.set_keepalive(true);
            log("socket configured");
            this._initTls();
            log("tls handshook");
            this._initStreams();
            log("streams initted");
            this._initMonitor();
        } catch (e) {
            log("Error connecting: " + e);
            
            this.emit("disconnected");
            return false;
        }
        
        this.emit("connected");
        
        return true;
    },
    
    transfer: function () {
        this._read();
    },
    
    _read: function () {
        log("Transfer._read()");
        this.srcStream.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, res) => {
                log("callback");
                let bytes = source.read_bytes_finish(res);
                log("bytes read: " + bytes);
                
                if (bytes.length) {
                    this._write(bytes);
                    this._read(stream);
                }
            }
        );
    },
    
    _write: function (bytes) {
        log("Transfer._write()");
        log(bytes);
    }
});


var Transfer = new Lang.Class({
    Name: "GSConnectTransfer",
    Extends: GObject.Object,
    
    _init: function (inStream, outStream) {
        this.parent();
        
        this.inStream = inStream;
        this.outStream = outStream;
    },
    
    start: function (size) {
        let chunk_size = 4096;
        let bytes_written = 0;
        
        this._read();
        
//        this._monitor = this.inStream.create_source(null);
//        this._monitor.set_callback((condition) => {
//            this._read();
//        });
//        this._monitor.attach(null);
        
//        while (bytes_written < size) {
//            this.inStream.read_bytes_async(
//                chunk_size,
//                GLib.PRIORITY_DEFAULT,
//                null,
//                (stream, res) => {
//                    let bytes = stream.read_bytes_finish(res);
//                    
//                    this.outStream.write_bytes_async(
//                        bytes,
//                        GLib.PRIORITY_DEFAULT,
//                        null,
//                        (stream, res) => {
//                            bytes_written += stream.write_bytes_finish(res);
//                        }
//                    );
//                }
//            );
//        }
//        
//        return true;
    },
    
    _read: function () {
        log("Transfer._read()");
        this.inStream.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, res) => {
                log("callback");
                let bytes = source.read_bytes_finish(res);
                log("bytes read: " + bytes);
                
                if (bytes.length) {
                    log("bytes read: " + bytes);
                    this._write(bytes);
                    this._read(stream);
                }
            }
        );
    },
    
    _write: function (bytes) {
        log(bytes);
    }
});


