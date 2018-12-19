'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * One-time check for Linux/FreeBSD scoket options
 */
var _LINUX_SOCKET_OPTIONS = false;

try {
    // This should throw on FreeBSD
    // https://github.com/freebsd/freebsd/blob/master/sys/netinet/tcp.h#L159
    new Gio.Socket({
        family: Gio.SocketFamily.IPV4,
        protocol: Gio.SocketProtocol.TCP,
        type: Gio.SocketType.STREAM
    }).get_option(6, 5);

    // Otherwise we can use Linux socket options
    debug('Setting socket options for Linux');
    _LINUX_SOCKET_OPTIONS = true;
} catch (e) {
    debug('Setting socket options for FreeBSD');
    _LINUX_SOCKET_OPTIONS = false;
}


/**
 * Packet
 *
 * The packet class is a simple Object-derived class. It only exists to offer
 * conveniences for coercing to a string writable to a channel and constructing
 * from Strings and Objects. In future, it could probably be optimized to avoid
 * excessive shape-trees since it's the most common object in the protocol.
 */
var Packet = class Packet {

    constructor(data = null) {
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
var Channel = class Channel {

    constructor(params) {
        Object.assign(this, params);
    }

    get cancellable() {
        if (this._cancellable === undefined) {
            this._cancellable = new Gio.Cancellable();
        }

        return this._cancellable;
    }

    get certificate() {
        if (this.type === 'tcp') {
            return this._connection.get_peer_certificate();
        }

        return null;
    }

    get service() {
        return Gio.Application.get_default();
    }

    /**
     * Set socket options
     */
    _initSocket(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection.socket.set_keepalive(true);

            if (_LINUX_SOCKET_OPTIONS) {
                connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
                connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
                connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
            } else {
                connection.socket.set_option(6, 256, 10); // TCP_KEEPIDLE
                connection.socket.set_option(6, 512, 5);  // TCP_KEEPINTVL
                connection.socket.set_option(6, 1024, 3); // TCP_KEEPCNT
            }
        }

        return connection;
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        let data = stream.read_line_finish_utf8(res)[0];
                        stream.close(null);

                        // Store the identity as an object property
                        this.identity = new Packet(data);

                        // Reject connections without a deviceId
                        if (!this.identity.body.deviceId) {
                            throw new Error('missing deviceId');
                        }

                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            connection.output_stream.write_all_async(
                `${this.service.identity}`,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
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
     * Handshake Gio.TlsConnection
     */
    _handshake(connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = Gio.TlsCertificateFlags.EXPIRED;
            connection.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;

            connection.handshake_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (connection, res) => {
                    try {
                        resolve(connection.handshake_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _authenticate(connection) {
        // FIXME: This is a hack, error propogation needs to be fixed
        try {
            // Standard TLS Handshake
            await this._handshake(connection);

            // Bail if deviceId is missing
            if (!this.identity.body.hasOwnProperty('deviceId')) {
                throw new Error('missing deviceId');
            }

            // Get a GSettings object for this deviceId
            let settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(gsconnect.app_id + '.Device', true),
                path: gsconnect.settings.path + 'device/' + this.identity.body.deviceId + '/'
            });
            let cert_pem = settings.get_string('certificate-pem');

            // If we have a certificate for this deviceId, we can verify it
            if (cert_pem !== '') {
                let certificate = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
                let valid = certificate.is_same(connection.peer_certificate);

                // This is a fraudulent certificate; notify the user
                if (!valid) {
                    let error = new Error();
                    error.name = 'AuthenticationError';
                    error.deviceName = this.identity.body.deviceName;
                    error.deviceHost = connection.base_io_stream.get_remote_address().address.to_string();
                    this.service.notify_error(error);

                    throw error;
                }
            }

            return connection;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsClientConnection
     * and initiate handshake, otherwise just return it.
     */
    _clientEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsClientConnection.new(
                connection,
                connection.socket.remote_address
            );
            connection.set_certificate(this.service.certificate);

            return this._authenticate(connection);
        } else {
            return Promise.resolve(connection);
        }
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsServerConnection
     * and initiate handshake, otherwise just return it.
     */
    _serverEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsServerConnection.new(
                connection,
                this.service.certificate
            );

            // If we're the server, we trust-on-first-use and verify after
            let _id = connection.connect('accept-certificate', (conn) => {
                conn.disconnect(_id);
                return true;
            });

            return this._authenticate(connection);
        } else {
            return Promise.resolve(connection);
        }
    }

    /**
     * Attach the channel to a device and monitor the input stream for packets
     *
     * @param {Device.Device} - The device to attach to
     */
    attach(device) {
        // Detach any existing channel
        if (device._channel && device._channel !== this) {
            device._channel.cancellable.disconnect(device._channel._id);
            device._channel.close();
        }

        // Attach the new channel and parse it's identity
        device._channel = this;
        this._id = this.cancellable.connect(device._setDisconnected.bind(device));
        device._handleIdentity(this.identity);

        // Setup streams for packet exchange
        this.input_stream = new Gio.DataInputStream({
            base_stream: this._connection.input_stream
        });

        this.output_queue = [];
        this.output_stream = this._connection.output_stream;

        // Start listening for packets
        this.receive(device);

        // Emit connected:: if necessary
        if (!device.connected) {
            device._setConnected();
        }
    }

    /**
     * Open an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     * @return {Boolean} - %true on connected, %false otherwise
     */
    async open(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Accept an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        debug(`${this.constructor.name}:${this.type}${(this.uuid) ? '(Transfer)' : ''}`);

        // Cancel any queued operations
        this.cancellable.cancel();

        // Close any streams
        [this._connection, this.input_stream, this.output_stream].map(stream => {
            try {
                stream.close(null);
            } catch (e) {
                // Silence errors
            }
        });

        if (this._listener) {
            try {
                this._listener.close();
            } catch (e) {
                // Silence errors
            }
        }
    }

    /**
     * Receive a packet from the channel and call receivePacket() on the device
     *
     * @param {Device.Device} device - The device which will handle the packet
     */
    receive(device) {
        this.input_stream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this.cancellable,
            (stream, res) => {
                let data, packet;

                try {
                    // Try to read and parse a packet
                    data = stream.read_line_finish_utf8(res)[0];

                    // Queue another receive() before handling the packet
                    this.receive(device);

                    // In case %null is returned we don't want an error thrown
                    // when trying to parse it as a packet
                    if (data !== null) {
                        packet = new Packet(data);
                        debug(packet, this.identity.body.deviceName);
                        device.receivePacket(packet);
                    }
                } catch (e) {
                    debug(e, this.identity.body.deviceName);
                    this.close();
                }
            }
        );
    }

    _send(packet) {
        return new Promise((resolve, reject) => {
            this.output_stream.write_all_async(
                packet.toString(),
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        resolve(stream.write_all_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Send a packet to a device
     *
     * See: https://github.com/KDE/kdeconnect-kde/blob/master/core/backends/lan/landevicelink.cpp#L92-L94
     *
     * @param {object} packet - An dictionary of packet data
     */
    async send(packet) {
        let next;

        try {
            this.output_queue.push(new Packet(packet));

            if (!this.__lock) {
                this.__lock = true;

                while ((next = this.output_queue.shift())) {
                    await this._send(next);
                    debug(next, this.identity.body.deviceName);
                }

                this.__lock = false;
            }
        } catch (e) {
            debug(e, this.identity.body.deviceName);
            this.close();
        }
    }
};


/**
 * File Transfer base class
 */
var Transfer = class Transfer extends Channel {

    /**
     * @param {object} params - Transfer parameters
     * @param {Device.Device} params.device - The device that owns this transfer
     * @param {Gio.InputStream} params.input_stream - The input stream (read)
     * @param {Gio.OutputStrea} params.output_stream - The output stream (write)
     * @param {number} params.size - The size of the transfer in bytes
     */
    constructor(params) {
        super(params);
        this.device._transfers.set(this.uuid, this);
    }

    get identity() {
        return this.device._channel.identity;
    }

    get type() {
        return 'transfer';
    }

    // For bluetooth transfers this also serves as the per-transfer profile UUID
    get uuid() {
        if (this._uuid === undefined) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    }

    set uuid(uuid) {
        this._uuid = uuid;
    }

    /**
     * Override in protocol implementation
     */
    async upload() {
        throw new GObject.NotImplementedError();
    }

    async download() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Cancel the transfer in progress
     */
    cancel() {
        this.close();
    }

    close() {
        this.device._transfers.delete(this.uuid);
        super.close();
    }

    /**
     * Transfer using g_output_stream_splice()
     *
     * @return {Boolean} - %true on success, %false on failure.
     */
    async _transfer() {
        let result = false;

        try {
            result = await new Promise((resolve, reject) => {
                this.output_stream.splice_async(
                    this.input_stream,
                    Gio.OutputStreamSpliceFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    this.cancellable,
                    (source, res) => {
                        try {
                            if (source.splice_finish(res) < this.size) {
                                throw new Error('incomplete data');
                            }

                            resolve(true);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }
};

