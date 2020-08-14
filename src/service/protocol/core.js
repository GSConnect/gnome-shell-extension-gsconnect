'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * The packet class is a simple Object-derived class, offering some conveniences
 * for working with KDE Connect packets.
 */
var Packet = class Packet {

    constructor(data = null) {
        this.id = 0;
        this.type = undefined;
        this.body = {};

        if (typeof data === 'string')
            Object.assign(this, JSON.parse(data));
        else if (data !== null)
            Object.assign(this, data);
    }

    [Symbol.toPrimitive](hint) {
        this.id = Date.now();

        if (hint === 'string')
            return `${JSON.stringify(this)}\n`;

        if (hint === 'number')
            return `${JSON.stringify(this)}\n`.length;

        return true;
    }

    get [Symbol.toStringTag]() {
        return `Packet:${this.type}`;
    }

    /**
     * Deserialize and return a new Packet from an Object or string.
     *
     * @param {Object|string} data - A string or dictionary to deserialize
     * @return {Core.Packet} A new packet object
     */
    static deserialize(data) {
        return new Packet(data);
    }

    /**
     * Serialize the packet as a single line with a terminating new-line (`\n`)
     * character, ready to be written to a channel.
     *
     * @return {string} A serialized packet
     */
    serialize() {
        this.id = Date.now();
        return `${JSON.stringify(this)}\n`;
    }

    /**
     * Update the packet from a dictionary or string of JSON
     *
     * @param {Object|string} source - Source data
     */
    update(source) {
        try {
            if (typeof data === 'string')
                Object.assign(this, JSON.parse(source));
            else
                Object.assign(this, source);
        } catch (e) {
            throw Error(`Malformed data: ${e.message}`);
        }
    }

    /**
     * Check if the packet has a payload.
     *
     * @return {boolean} %true if @packet has a payload
     */
    hasPayload() {
        if (!this.hasOwnProperty('payloadSize'))
            return false;

        if (!this.hasOwnProperty('payloadTransferInfo'))
            return false;

        return (Object.keys(this.payloadTransferInfo).length > 0);
    }
};


/**
 * Channel
 *
 * Channels are essentially wrappers around an I/O stream pair that handle KDE
 * Connect identity exchange and either packet or data exchange.
 *
 * There are effectively two types of channels: packet exchange channels and
 * data transfer channels. Both channel types begin by exchanging identity
 * packets and then performing whatever encryption or authentication is
 * appropriate for the transport protocol.
 *
 *
 * Packet Channels
 *
 * Packet exchange channels are used to send or receive packets, which are JSON
 * objects serialized as single line with a terminating new-line character
 * marking the end of the packet. The only packet type allowed to be exchanged
 * before authentication is `kdeconnect.identity`. The only packets allowed
 * before pairing are `kdeconnect.identity` and `kdeconnect.pair`.
 *
 *
 * Transfer Channels
 *
 * Data transfer channels are used to send or receive streams of binary data and
 * are only possible for paired and authenticated devices. Once the
 * identification and authentication has completed, the binary payload is read
 * or written and then the channel is closed (unless cancelled first).
 *
 * These channels are opened when the uploading party sends a packet with two
 * extra fields in the top-level of the packet: `payloadSize` (size in bytes)
 * and `payloadTransferInfo` which contains protocol specific information such
 * as a TCP port. The uploading party then waits for an incoming connection that
 * corresponds with the `payloadTransferInfo` field.
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectChannel',
    Requires: [GObject.Object],
}, class Channel extends GObject.Interface {

    get address() {
        throw new GObject.NotImplementedError();
    }

    get backend() {
        if (this._backend === undefined)
            this._backend = null;

        return this._backend;
    }

    set backend(backend) {
        this._backend = backend;
    }

    get cancellable() {
        if (this._cancellable === undefined)
            this._cancellable = new Gio.Cancellable();

        return this._cancellable;
    }

    get input_stream() {
        if (this._input_stream === undefined) {
            if (this._connection instanceof Gio.IOStream)
                return this._connection.get_input_stream();

            return null;
        }

        return this._input_stream;
    }

    set input_stream(stream) {
        this._input_stream = stream;
    }

    get output_stream() {
        if (this._output_stream === undefined) {
            if (this._connection instanceof Gio.IOStream)
                return this._connection.get_output_stream();

            return null;
        }

        return this._output_stream;
    }

    set output_stream(stream) {
        this._output_stream = stream;
    }

    get service() {
        if (this._service === undefined)
            this._service = Gio.Application.get_default();

        return this._service;
    }

    get uuid() {
        if (this._uuid === undefined)
            this._uuid = GLib.uuid_string_random();

        return this._uuid;
    }

    set uuid(uuid) {
        this._uuid = uuid;
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Read a packet.
     *
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     * @return {Promise<Core.Packet>} The packet
     */
    readPacket(cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        if (!(this.input_stream instanceof Gio.DataInputStream)) {
            this.input_stream = new Gio.DataInputStream({
                base_stream: this.input_stream,
            });
        }

        return new Promise((resolve, reject) => {
            this.input_stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (stream, res) => {
                    try {
                        let data = stream.read_line_finish_utf8(res)[0];

                        if (data === null) {
                            throw new Gio.IOErrorEnum({
                                message: 'End of stream',
                                code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                            });
                        }

                        resolve(new Packet(data));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Send a packet.
     *
     * @param {Core.Packet} packet - The packet to send
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     * @return {Promise<boolean>} %true if successful
     */
    sendPacket(packet, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        return new Promise((resolve, reject) => {
            this.output_stream.write_all_async(
                packet.serialize(),
                GLib.PRIORITY_DEFAULT,
                cancellable,
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
     * Override these in subclasses to negotiate payload transfers. `download()`
     * and `upload()` should cleanup after themselves and return a success
     * boolean.
     *
     * The default implementation will always report failure, for protocols that
     * won't or don't yet support payload transfers.
     *
     * @param {Object} params - A dictionary of transfer parameters
     */
    createTransfer(params) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Reject a transfer.
     *
     * @param {Core.Packet} packet - A packet with payload info
     */
    rejectTransfer(packet) {
        throw new GObject.NotImplementedError();
    }

    async download() {
        let result = false;

        try {
            throw new GObject.NotImplementedError();
        } catch (e) {
            debug(e, this.identity.body.deviceName);
        } finally {
            this.close();
        }

        return result;
    }

    async upload() {
        let result = false;

        try {
            throw new GObject.NotImplementedError();
        } catch (e) {
            debug(e, this.identity.body.deviceName);
        } finally {
            this.close();
        }

        return result;
    }

    /**
     * Transfer using g_output_stream_splice()
     *
     * @return {boolean} %true on success, %false on failure.
     */
    async transfer() {
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
                            if (source.splice_finish(res) < this.size)
                                throw new Error('incomplete data');

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
});


/**
 * ChannelService
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectChannelService',
    Requires: [GObject.Object],
    Properties: {
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The name of the backend',
            GObject.ParamFlags.READABLE,
            null
        ),
    },
    Signals: {
        'channel': {
            flags: GObject.SignalFlags.RUN_LAST,
            param_types: [Channel.$gtype],
            return_type: GObject.TYPE_BOOLEAN,
        },
    },
}, class ChannelService extends GObject.Interface {

    get name() {
        throw new GObject.NotImplementedError();
    }

    get service() {
        if (this._service === undefined)
            this._service = Gio.Application.get_default();

        return this._service;
    }

    /**
     * Broadcast directly to @address or the whole network if %null
     *
     * @param {string} [address] - A string address
     */
    broadcast(address = null) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Emit Core.ChannelService::channel
     *
     * @param {Core.Channel} channel - The new channel
     */
    channel(channel) {
        if (!this.emit('channel', channel))
            channel.close();
    }

    /**
     * Start the channel service. Implementations should throw an error if the
     * service fails to meet any of its requirements for opening or accepting
     * connections.
     */
    start() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Stop the channel service.
     */
    stop() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Destroy the channel service.
     */
    destroy() {
    }
});

