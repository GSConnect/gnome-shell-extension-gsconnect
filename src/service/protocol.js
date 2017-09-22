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
        
        if (data === false) {
            return;
        } else if (typeof data === "string") {
            this.fromData(data);
        } else if (typeof data === "object") {
            this.fromPacket(data);
        } else {
            log("unsupported packet source: " + typeof data);
            log("unsupported packet source: " + data);
        }
    },
    
    _check: function (obj) {
        if (!obj.hasOwnProperty("type")) {
            log("packet is missing 'type' field");
            return false;
        } else if (!obj.hasOwnProperty("body")) {
            log("packet is missing 'body' field");
            return false;
        } else if (!obj.hasOwnProperty("id")) {
            log("packet is missing 'id' field");
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
                id: Date.now(), //FIXME
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
    
    // Wrap connection in TlsServerConnection and handshake
    _initTls: function (mode="server") {
        if (mode === "server") {
            this._connection = Gio.TlsServerConnection.new(
                this._connection,
                this.device.daemon.certificate
            );
        } else if (mode === "client") {
            this._connection = Gio.TlsClientConnection.new(
                this._connection,
                this._connection.socket.remote_address
            );
            this._connection.set_certificate(this.device.daemon.certificate);
        }
        
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
    
    _init: function (device, port, srcStream=null, destStream=null, size) {
        this.parent(device, port);
        
        this.srcStream = srcStream;
        this.destStream = destStream;
        this.bytesWritten = 0;
        this.size = size;
    },
    
    _initTransfer: function () {
        // Download
        if (this.srcStream === null) {
            this._initTls("client");
            this.srcStream = this._connection.get_input_stream();
        // Upload
        } else {
            this._initTls("server");
            this.destStream = this._connection.get_output_stream();
        }
        
        return true;
    },
    
    opened: function (client, res) {
        log("TransferChannel.opened(" + this.device.id + ")");
        
        try {
            this._connection = client.connect_finish(res);
            log("connected");
            this._initSocket();
            log("socket configured");
            this._initTransfer();
        } catch (e) {
            log("Error connecting: " + e);
            
            this.emit("disconnected");
            return false;
        }
        
        this.emit("connected");
        this.transfer();
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
                let bytes = source.read_bytes_finish(res);
                
                if (bytes.get_size()) {
                    this._write(bytes);
                } else {
                    this.close()
                }
            }
        );
    },
    
    _write: function (bytes) {
        log("Transfer._write()");
        this.destStream.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, res) => {
                this.bytesWritten += source.write_bytes_finish(res);
                log("bytes written: " + this.bytesWritten);
                this._read();
            }
        );
    }
});


