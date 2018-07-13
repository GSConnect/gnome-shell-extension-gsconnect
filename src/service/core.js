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

        Object.assign(this, {
            id: 0,
            type: '',
            body: {}
        });

        if (data === false) {
            return;
        } else if (typeof data === 'string') {
            this.fromData(data);
        } else {
            this.fromPacket(data);
        }
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
        try {
            let json = JSON.parse(data);
            Object.assign(this, json);
        } catch (e) {
            throw Error('Malformed packet');
        }
    }

    fromPacket(packet) {
        try {
            let json = JSON.parse(JSON.stringify(packet));
            Object.assign(this, json);
        } catch (e) {
            throw Error('Malformed packet');
        }
    }

    [Symbol.toPrimitive](hint) {
        this.id = Date.now();

        switch (hint) {
            case 'string':
                return `${JSON.stringify(this)}\n`;
            case 'number':
                return `${JSON.stringify(this)}\n`.length;
            default:
                return true;
        }
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

        // We need this to lookup the certificate in GSettings
        this.identity = { body: { deviceId: deviceId } };
        this.service = Gio.Application.get_default();
    }

    get certificate() {
        if (typeof this._connection.get_peer_certificate === 'function') {
            return this._connection.get_peer_certificate();
        }

        return null;
    }

    get type() {
        // TODO: This seems like a pretty flaky test
        if (typeof this._connection.get_local_address === 'function') {
            return 'bluetooth';
        } else {
            return 'tcp';
        }
    }

    /**
     * Set socket options
     */
    _initSocket(connection) {
        return new Promise((resolve, reject) => {
            if (connection instanceof Gio.TcpConnection) {
                connection.socket.set_keepalive(true);
                connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
                connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
                connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
            }

            resolve(connection);
        });
    }

    /**
     * Read the identity packet from the Gio.SocketConnection file descriptor
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    let [data, len] = stream.read_line_finish(res);
                    stream.close(null);

                    // Store the identity as an object property
                    this.identity = new Packet(data.toString());

                    resolve(connection);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Write our identity packet to the Gio.SocketConnection file descriptor
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            connection.output_stream.write_all_async(
                this.service.identity.toString(),
                GLib.PRIORITY_DEFAULT,
                null,
                (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
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
        let cert_pem = settings.get_string('certificate-pem');

        // If this device is paired, verify the connection certificate
        if (cert_pem) {
            let cert = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
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
                        connection.handshake_finish(res);
                        resolve(connection);
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
            this.input_stream = new Gio.DataInputStream({
                base_stream: connection.input_stream
            });

            this.output_stream = new Gio.DataOutputStream({
                base_stream: connection.output_stream
            });

            this._monitor = connection.input_stream.create_source(null);
            this._monitor.set_callback(this.receive.bind(this));
            this._monitor.attach(null);

            resolve(connection);
        });
    }

    /**
     * Open a channel (outgoing connection)
     * @param {Gio.InetSocketAddress} address - ...
     */
    async open(address) {
        log(`Connecting to ${this.identity.body.deviceId}`);

        try {
            this._connection = await new Promise((resolve, reject) => {
                let client = new Gio.SocketClient();

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);
            this._connection = await this._initPacketIO(this._connection);
            this.emit('connected');
        } catch (e) {
            log(`GSConnect: Error opening connection: ${e.message}`);
            debug(e);
            this.close();
        }
    }

    /**
     * Accept a channel (incoming connection)
     * @param {Gio.TcpConnection} connection - ...
     */
    async accept(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this._connection = await this._initPacketIO(this._connection);
            this.emit('connected');
        } catch(e) {
            log(`GSConnect: Error accepting connection: ${e.message}`);
            debug(e);
            this.close();
        }
    }

    close() {
        if (this._monitor) {
            try {
                this._monitor.destroy();
            } catch (e) {
                debug(e.message);
            }
        }

        try {
            this._connection.close(null);
        } catch (e) {
            debug(e.message);
        }

        if (this._listener) {
            try {
                this._listener.close();
            } catch (e) {
                debug(e.message);
            }
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
            this.output_stream.put_string(packet.toString(), null);
        } catch (e) {
            debug(e.message);
        }
    }

    /**
     * Receive a packet from a device, emitting 'received::' with the packet
     */
    receive() {
        try {
            let data = this.input_stream.read_line(null)[0];
            let packet = new Packet(data.toString());

            if (packet.type === 'kdeconnect.identity') {
                this.identity = packet;
            }

            this.emit('received', packet);

            return GLib.SOURCE_CONTINUE;
        } catch (e) {
            this.close();
            return GLib.SOURCE_REMOVE;
        }
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
    GTypeName: 'GSConnectCoreTransfer',
    Signals: {
        'started': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'progress': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_INT ]
        },
        'cancelled': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'failed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        },
        'succeeded': {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    },
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'TransferDevice',
            'The device associated with this transfer',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'size': GObject.ParamSpec.uint(
            'size',
            'TransferSize',
            'The size in bytes of the transfer',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32,
            0
        ),
        'uuid': GObject.ParamSpec.string(
            'uuid',
            'TransferUUID',
            'The UUID of this transfer',
            GObject.ParamFlags.READABLE,
            ''
        )
    }
}, class Transfer extends Channel {

    _init(params) {
        super._init(params.device.id);

        this._cancellable = new Gio.Cancellable();

        this._device = params.device;
        this.input_stream = params.input_stream;
        this.output_stream = params.output_stream;
        this._size = params.size;

        this.checksum = params.checksum;
        this._checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
        this._written = 0;
        this._progress = 0;
    }

    get device() {
        return this._device;
    }

    get size() {
        return this._size || 0;
    }

    get uuid() {
        if (!this._uuid) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    }

    /**
     * Override in protocol implementation
     */
    upload() {
    }

    upload_accept() {
    }

    /**
     * Override in protocol implementation
     */
    download() {
    }

    /**
     * Start the transfer and emit the 'started' signal
     */
    start() {
        this.emit('started');
        this._read();
    }

    /**
     * Cancel the transfer in progress
     */
    cancel() {
        this._cancellable.cancel();
        this.emit('cancelled');
    }

    /**
     * Emit the progress signal with an integer between 0-100
     * @param {Number} increment - The increment to emit progress signals at
     */
    progress(increment=1) {
        let progress = Math.floor(this._written / this.size * 100);

        if (progress - this._progress >= increment) {
            this.emit('progress', progress);
        }

        this._progress = progress;
    }

    _read() {
        if (this._cancellable.is_cancelled()) { return; }

        this.input_stream.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                let bytes;

                try {
                    bytes = source.read_bytes_finish(res);
                } catch (e) {
                    debug(e);
                    this.emit('failed', e.message);
                    return;
                }

                // Data to write
                if (bytes.get_size()) {
                    this._write(bytes);
                    this._checksum.update(bytes.unref_to_array());
                // Expected more data
                } else if (this.size > this._written) {
                    this.close();
                    this.emit('failed', 'Incomplete transfer');
                // Data should match the checksum
                } else if (this.checksum && this.checksum !== this._checksum.get_string()) {
                    this.close();
                    this.emit('failed', 'Checksum mismatch');
                // All done
                } else {
                    debug('Completed transfer of ' + this.size + ' bytes');
                    this.close();
                    this.emit('succeeded');
                }
            }
        );
    }

    _write(bytes) {
        if (this._cancellable.is_cancelled()) { return; }

        this.output_stream.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                try {
                    this._written += source.write_bytes_finish(res);
                } catch (e) {
                    debug(e);
                    this.emit('failed', e.message);
                    return;
                }

                this.emit('progress', (this._written / this.size) * 100);
                this._read();
            }
        );
    }
});

