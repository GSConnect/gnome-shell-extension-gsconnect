'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Packet
 */
var Packet = GObject.registerClass({
    GTypeName: 'GSConnectCorePacket',
    Properties: {
        'file': GObject.ParamSpec.object(
            'file',
            'PacketFile',
            'The file associated with the packet',
            GObject.ParamFlags.READABLE,
            Gio.File
        )
    }
}, class Packet extends GObject.Object {

    _init(data=false) {
        super._init();

        this.id = 0;
        this.type = '';
        this.body = {};

        if (data === false) {
            return;
        } else if (typeof data === 'string') {
            this.fromData(data);
        } else if (typeof data === 'object') {
            this.fromPacket(data);
        } else {
            log('Error: unsupported packet source: ' + typeof data);
        }
    }

    // TODO: this means *complete* packets have to be set at construction
    _check(obj) {
        if (!obj.hasOwnProperty('type')) {
            debug('Packet: missing type field');
            return false;
        } else if (!obj.hasOwnProperty('body')) {
            debug('Packet: missing body field');
            return false;
        } else if (!obj.hasOwnProperty('id')) {
            debug('Packet: missing id field');
            return false;
        }

        return true;
    }

    // TODO
    setPayload(file) {
        if (!file instanceof Gio.File) {
            throw TypeError('must be Gio.File');
        }

        let info = file.query_info('standard::size', 0, null);
        this.payloadSize = file.query_info('standard::size', 0, null).get_size();

        let transfer = new Transfer({
            device: device,
            size: this.payloadSize,
            input_stream: file.read(null)
        });

        transfer.upload().then(port => {
            let packet = new Protocol.Packet({
                id: 0,
                type: 'kdeconnect.share.request',
                body: { filename: file.get_basename() },
                payloadSize: info.get_size(),
                payloadTransferInfo: { port: port }
            });

            device._channel.send(packet);
        });

        this._payloadFile = file;
        this._payloadStream = file.read(null);
    }

    fromData(data) {
        let json;

        try {
            json = JSON.parse(data);
        } catch (e) {
            logError(e);
            log('Data: %s'.format(data));
            return;
        }

        if (this._check(json)) {
            Object.assign(this, json);
        } else {
            throw Error('Packet.fromData(): Malformed packet');
        }
    }

    // TODO: better merging than this
    fromPacket(packet) {
        if (this._check(packet)) {
            Object.assign(this, JSON.parse(JSON.stringify(packet)));
        } else {
            throw Error('Packet.fromPacket(): Malformed packet');
        }
    }

    [Symbol.toPrimitive](hint) {
        if (hint === 'number') {
            this.id = GLib.DateTime.new_now_local().to_unix();
            return `${JSON.stringify(this)}\n`.length;
        }

        if (hint === 'string') {
            this.id = GLib.DateTime.new_now_local().to_unix();
            return `${JSON.stringify(this)}\n`;
        }

        return true;
    }

    toString() {
        return `${this}`;
    }
});


/**
 * Data Channel
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectCoreChannel',
    Signals: {
        'connected': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'disconnected': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'received': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'TlsCertificate',
            'The TLS Certificate for this connection',
            GObject.ParamFlags.READABLE,
            Gio.TlsCertificate
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'Data Channel Type',
            'The protocol this data channel uses',
            GObject.ParamFlags.READABLE,
            'tcp'
        )
    }
}, class Channel extends GObject.Object {

    _init(deviceId) {
        super._init();

        this.service = Gio.Application.get_default();

        // We need this to lookup the certificate in GSettings
        this.identity = { body: { deviceId: deviceId } };

        this._monitor = 0;
    }

    get certificate() {
        if (typeof this._connection.get_peer_certificate === 'function') {
            return this._connection.get_peer_certificate();
        }

        return null;
    }

    get type() {
        if (typeof this._connection.get_local_address === 'function') {
            return 'bluetooth';
        } else {
            return 'tcp';
        }
    }

    /**
     * Set TCP socket options
     */
    _initSocket(connection) {
        return new Promise((resolve, reject) => {
            if (connection instanceof Gio.TcpConnection) {
                connection.socket.set_keepalive(true);
                connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
                connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
                connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
            } else if (typeof connection.get_local_address === 'function') {
                connection.socket.set_blocking(false);
            }

            resolve(connection);
        });
    }

    /**
     * Read the identity packet from the Gio.SocketConnection file descriptor
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            let _input_stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });
            let [data, len] = _input_stream.read_line(null);
            _input_stream.close(null);

            // Store the identity as an object property
            this.identity = new Packet(data.toString());

            resolve(connection);
        });
    }

    /**
     * Write our identity packet to the Gio.SocketConnection file descriptor
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            let _output_stream = new Gio.DataOutputStream({
                base_stream: connection.output_stream,
                close_base_stream: false
            });
            _output_stream.put_string(this.service.identity.toString(), null);
            _output_stream.close(null);

            resolve(connection);
        });
    }

    /**
     * Verify connection certificate
     */
    _onAcceptCertificate(connection, peer_cert, flags) {
        log(`Authenticating ${this.identity.body.deviceId}`);

        // Get the settings for this deviceId
        let settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(gsconnect.app_id + '.Device', true),
            path: gsconnect.settings.path + 'device/' + this.identity.body.deviceId + '/'
        });

        // If this device is paired, verify the connection certificate
        if (settings.get_string('certificate-pem')) {
            let cert = Gio.TlsCertificate.new_from_pem(
                settings.get_string('certificate-pem'),
                -1
            );

            return (cert.verify(null, peer_cert) === 0);
        }

        // Otherwise trust on first use, we pair later
        return true;
    }

    /**
     * Handshake Gio.TlsConnection
     */
    _handshakeTls(connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = 0;
            connection.authentication_mode = 1;
            connection.connect(
                'accept-certificate',
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
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsClientConnection
     * and initiate handshake, otherwise just return it.
     */
    _clientEncryption(connection) {
        return new Promise((resolve, reject) => {
            if (connection instanceof Gio.TcpConnection) {
                connection = Gio.TlsClientConnection.new(
                    connection,
                    connection.socket.remote_address
                );
                connection.set_certificate(this.service.certificate);

                resolve(this._handshakeTls(connection));
            } else {
                resolve(connection);
            }
        });
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsServerConnection
     * and initiate handshake, otherwise just return it.
     */
    _serverEncryption(connection) {
        return new Promise((resolve, reject) => {
            if (connection instanceof Gio.TcpConnection) {
                connection = Gio.TlsServerConnection.new(
                    connection,
                    this.service.certificate
                );

                resolve(this._handshakeTls(connection));
            } else {
                resolve(connection);
            }
        });
    }

    /**
     * Init streams for reading/writing packets and monitor the input stream
     */
    _initPacketIO(connection) {
        return new Promise((resolve, reject) => {
            this._input_stream = new Gio.DataInputStream({
                base_stream: connection.input_stream
            });

            this._output_stream = new Gio.DataOutputStream({
                base_stream: connection.output_stream
            });

            this._monitor = this._input_stream.base_stream.create_source(null);
            this._monitor.set_callback(this.receive.bind(this));
            this._monitor.attach(null);

            resolve(connection);
        });
    }

    /**
     * Open a channel (outgoing connection)
     * @param {Gio.InetSocketAddress} address - ...
     */
    open(address) {
        log(`Connecting to ${this.identity.body.deviceId}`);

        // Open a new outgoing connection
        return new Promise((resolve, reject) => {
            let client = new Gio.SocketClient();

            client.connect_async(address, null, (client, res) => {
                try {
                    resolve(client.connect_finish(res));
                } catch (e) {
                    reject(e)
                }
            });
        // Set the usual socket options
        }).then(socketConnection => {
            return this._initSocket(socketConnection);
        // Send our identity packet
        }).then(socketConnection => {
            return this._sendIdent(socketConnection);
        // Authenticate the connection
        }).then(socketConnection => {
            return this._serverEncryption(socketConnection);
        // Store the certificate and init streams for packet exchange
        }).then(secureConnection => {
            return this._initPacketIO(secureConnection);
        // Set the connection and emit
        }).then(secureConnection => {
            this._connection = secureConnection;
            this.emit('connected');
        }).catch(e => {
            log(`GSConnect: Error opening connection: ${e.message}`);
            debug(e);
            this.close();
        });
    }

    /**
     * Accept a channel (incoming connection)
     * @param {Gio.TcpConnection} connection - ...
     */
    accept(connection) {
        // Set the usual socket options and receive the device's identity
        return this._initSocket(connection).then(socketConnection => {
            return this._receiveIdent(socketConnection);
        // Authenticate the connection
        }).then(socketConnection => {
            return this._clientEncryption(socketConnection);
        // Store the certificate and init streams for packet exchange
        }).then(secureConnection => {
            return this._initPacketIO(secureConnection);
        // Set the connection and emit
        }).then(secureConnection => {
            this._connection = secureConnection;
            this.emit('connected');
        }).catch(e => {
            log(`GSConnect: Error accepting connection: ${e.message}`);
            debug(e);
            this.close();
        });
    }

    close() {
        try {
            if (this._monitor > 0) {
                GLib.Source.remove(this._monitor);
                this._monitor = 0;
            }
        } catch (e) {
            debug(e);
        }

        try {
            this._connection.close(null);
            delete this._connection;
        } catch (e) {
            debug(e.message);
        }

        try {
            this._listener.close();
            delete this._listener;
        } catch (e) {
            debug(e.message);
        }

        this.emit('disconnected');
    }

    /**
     * Send a packet to a device
     * @param {Packet} packet - A packet object
     */
    send(packet) {
        debug(`${this.identity.body.deviceId}, ${packet}`);

        try {
            this._output_stream.put_string(packet.toString(), null);
        } catch (e) {
            // TODO: disconnect?
            debug(e.message);
        }
    }

    /**
     * Receive a packet from a device, emitting 'received::' with the packet
     */
    receive() {
        let data, length;

        try {
            [data, length] = this._input_stream.read_line(null);
        } catch (e) {
            debug(`${this.identity.body.deviceName}: ${e.message}`);
            this.close();
            return false;
        }

        if (!data) {
            this.close();
            return false;
        }

        let packet = new Packet(data.toString());

        if (packet.type === 'kdeconnect.identity') {
            this.identity = packet;
        }

        //debug(packet);
        this.emit('received', packet);
        return true;
    }
});

