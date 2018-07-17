'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Packet
 */
var Packet = class Packet {

    constructor(data=null) {
        this.id = 0;
        this.type = undefined;
        this.body = {};

        if (data === null) {
            return;
        } else if (typeof data === 'string') {
            this.fromString(data);
        } else {
            this.fromObject(data);
        }
    }

    /**
     * Update the packet from a string of JSON
     *
     * @param {string} data - A string of text
     */
    fromString(data) {
        try {
            let json = JSON.parse(data);
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
        }
    }

    /**
     * Update the packet from an Object, using and intermediate call to
     * JSON.stringify() to deep-copy the object, avoiding reference entanglement
     *
     * @param {string} data - An object
     */
    fromObject(data) {
        try {
            let json = JSON.parse(JSON.stringify(data));
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
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
};


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
        if (!this._connection) {
            return null;
        // TODO: This seems like a pretty flaky test
        } else if (typeof this._connection.get_local_address === 'function') {
            return 'bluetooth';
        } else {
            return 'tcp';
        }
    }

    /**
     * Set socket options
     */
    async _initSocket(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection.socket.set_keepalive(true);
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT

            //
            //connection.socket.blocking = false;
        }

        return connection;
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
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
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
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

        connection.disconnect(connection._authenticateCertificateId);

        // TODO: this is a hack for my mistake in GSConnect <= v10; it can
        //       be removed when it's safe to assume v10 is out of the wild
        if (!this.identity.body.deviceId) {
            return false;
        }

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
            connection._acceptCertificateId = connection.connect(
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
    async _clientEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsClientConnection.new(
                connection,
                connection.socket.remote_address
            );
            connection.set_certificate(this.service.certificate);

            return this._handshakeTls(connection);
        } else {
            return connection;
        }
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsServerConnection
     * and initiate handshake, otherwise just return it.
     */
    async _serverEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsServerConnection.new(
                connection,
                this.service.certificate
            );

            return this._handshakeTls(connection);
        } else {
            return connection;
        }
    }

    /**
     * Init streams for reading/writing packets and monitor the input stream
     */
    async _initPacketIO(connection) {
        this.input_stream = new Gio.DataInputStream({
            base_stream: connection.input_stream
        });

        this.output_stream = new Gio.DataOutputStream({
            base_stream: connection.output_stream
        });

        this._monitor = connection.input_stream.create_source(null);
        this._monitor.set_callback(this.receive.bind(this));
        this._monitor.attach(null);

        return connection;
    }

    /**
     * Open an outgoing connection
     *
     * Outgoing connections are opened in response to a received (or cached) UDP
     * packet, with a mandatory kdeconnect.identity packet being sent when the
     * connection is accepted.
     *
     * @param {Gio.InetSocketAddress} address - The address to open a connection
     */
    async open(address) {
        log(`GSConnect: Connecting to ${address.to_string()}`);

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
            log(`GSConnect: ${e.message}`);
            debug(e);
            this.close();
        }
    }

    /**
     * Accept an incoming connection
     *
     * Incoming connections are opened in response to a sent (or cached) UDP
     * packet, with a mandatory kdeconnect.identity packet being sent when the
     * connection is accepted.
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        log(`GSConnect: Connecting to ${connection.get_remote_address().to_string()}`);

        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this._connection = await this._initPacketIO(this._connection);
            this.emit('connected');
        } catch(e) {
            log(`GSConnect: ${e.message}`);
            debug(e);
            this.close();
        }
    }

    /**
     * Close all streams associated with this channel and emit 'disconnected::'
     */
    close() {
        if (this._monitor) {
            try {
                this._monitor.destroy();
            } catch (e) {
                debug(e, this.identity.body.deviceName);
            }
        }

        [this._connection, this.input_stream, this.output_stream].map(stream => {
            try {
                stream.close(null);
            } catch (e) {
                debug(e, this.identity.body.deviceName);
            }
        });

        if (this._listener) {
            try {
                this._listener.close();
            } catch (e) {
                debug(e, this.identity.body.deviceName);
            }
        }

        this.emit('disconnected');
    }

    /**
     * Send a packet to a device.
     *
     * TODO: Currently, we don't consider failed writes to consititute a broken
     * connection and just log a warning. This should be investigated and tested
     * over a period of time.
     *
     * @param {Packet} packet - A packet object
     */
    send(packet) {
        debug(packet, this.identity.body.deviceName);

        try {
            this.output_stream.put_string(packet.toString(), null);
        } catch (e) {
            logWarning(e, this.identity.body.deviceName);
        }
    }

    /**
     * Receive a packet from a device, emitting 'received::' with the packet
     */
    receive() {
        try {
            let data = this.input_stream.read_line(null)[0];
            let packet = new Packet(data.toString());

            debug(packet, this.identity.body.deviceName);

            // Update the channel property
            if (packet.type === 'kdeconnect.identity') {
                this.identity = packet;
            }

            this.emit('received', packet);

            return GLib.SOURCE_CONTINUE;
        } catch (e) {
            debug(e, this.identity.body.deviceName);
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

