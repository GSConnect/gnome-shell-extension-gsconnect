'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Get the local device type.
 *
 * @return {string} A device type string
 */
function _getDeviceType() {
    try {
        let type = GLib.file_get_contents('/sys/class/dmi/id/chassis_type')[1];

        type = Number(imports.byteArray.toString(type));

        if ([8, 9, 10, 14].includes(type))
            return 'laptop';

        return 'desktop';
    } catch (e) {
        return 'desktop';
    }
}


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
     * @param {Object|string} data - Source data
     */
    update(data) {
        try {
            if (typeof data === 'string')
                Object.assign(this, JSON.parse(data));
            else
                Object.assign(this, data);
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
 * Channel objects handle KDE Connect packet exchange and data transfers for
 * devices. The implementation is responsible for all negotiation of the
 * underlying protocol.
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectChannel',
    Properties: {
        'closed': GObject.ParamSpec.boolean(
            'closed',
            'Closed',
            'Whether the channel has been closed',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
}, class Channel extends GObject.Object {

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

    get closed() {
        if (this._closed === undefined)
            this._closed = false;

        return this._closed;
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

    get uuid() {
        if (this._uuid === undefined)
            this._uuid = GLib.uuid_string_random();

        return this._uuid;
    }

    set uuid(uuid) {
        this._uuid = uuid;
    }

    /**
     * Close the channel.
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
                        const data = stream.read_line_finish_utf8(res)[0];

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
     * Reject a transfer.
     *
     * @param {Core.Packet} packet - A packet with payload info
     */
    rejectTransfer(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Download a payload from a device. Typically implementations will override
     * this with an async function.
     *
     * @param {Core.Packet} packet - A packet
     * @param {Gio.OutputStream} target - The target stream
     * @param {Gio.Cancellable} [cancellable] - A cancellable for the upload
     */
    download(packet, target, cancellable = null) {
        throw new GObject.NotImplementedError();
    }


    /**
     * Upload a payload to a device. Typically implementations will override
     * this with an async function.
     *
     * @param {Core.Packet} packet - The packet describing the transfer
     * @param {Gio.InputStream} source - The source stream
     * @param {number} size - The payload size
     * @param {Gio.Cancellable} [cancellable] - A cancellable for the upload
     */
    upload(packet, source, size, cancellable = null) {
        throw new GObject.NotImplementedError();
    }
});


/**
 * ChannelService implementations provide Channel objects, emitting the
 * ChannelService::channel signal when a new connection has been accepted.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectChannelService',
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active',
            'Active',
            'Whether the service is active',
            GObject.ParamFlags.READABLE,
            false
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'ID',
            'The hostname or other network unique id',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The name of the backend',
            GObject.ParamFlags.READWRITE,
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
}, class ChannelService extends GObject.Object {

    get active() {
        if (this._active === undefined)
            this._active = false;

        return this._active;
    }

    get name() {
        if (this._name === undefined)
            this._name = GLib.get_host_name();

        return this._name;
    }

    set name(name) {
        if (this.name === name)
            return;

        this._name = name;
        this.notify('name');
    }

    get id() {
        if (this._id === undefined)
            this._id = GLib.uuid_string_random();

        return this._id;
    }

    set id(id) {
        if (this.id === id)
            return;

        this._id = id;
    }

    get identity() {
        if (this._identity === undefined)
            this.buildIdentity();

        return this._identity;
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
     * Rebuild the identity packet used to identify the local device. An
     * implementation may override this to make modifications to the default
     * capabilities if necessary (eg. bluez without SFTP support).
     */
    buildIdentity() {
        this._identity = new Packet({
            id: 0,
            type: 'kdeconnect.identity',
            body: {
                deviceId: this.id,
                deviceName: this.name,
                deviceType: _getDeviceType(),
                protocolVersion: 7,
                incomingCapabilities: [],
                outgoingCapabilities: [],
            },
        });

        for (const name in imports.service.plugins) {
            // Exclude mousepad/presenter capability in unsupported sessions
            if (!HAVE_REMOTEINPUT && ['mousepad', 'presenter'].includes(name))
                continue;

            const meta = imports.service.plugins[name].Metadata;

            if (meta === undefined)
                continue;

            for (const type of meta.incomingCapabilities)
                this._identity.body.incomingCapabilities.push(type);

            for (const type of meta.outgoingCapabilities)
                this._identity.body.outgoingCapabilities.push(type);
        }
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


/**
 * A class representing a file transfer.
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectTransfer',
    Properties: {
        'channel': GObject.ParamSpec.object(
            'channel',
            'Channel',
            'The channel that owns this transfer',
            GObject.ParamFlags.READWRITE,
            Channel.$gtype
        ),
        'completed': GObject.ParamSpec.boolean(
            'completed',
            'Completed',
            'Whether the transfer has completed',
            GObject.ParamFlags.READABLE,
            false
        ),
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device that created this transfer',
            GObject.ParamFlags.READWRITE,
            GObject.Object.$gtype
        ),
    },
}, class Transfer extends GObject.Object {

    _init(params = {}) {
        super._init(params);

        this._cancellable = new Gio.Cancellable();
        this._items = [];
    }

    get channel() {
        if (this._channel === undefined)
            this._channel = null;

        return this._channel;
    }

    set channel(channel) {
        if (this.channel === channel)
            return;

        this._channel = channel;
    }

    get completed() {
        if (this._completed === undefined)
            this._completed = false;

        return this._completed;
    }

    get device() {
        if (this._device === undefined)
            this._device = null;

        return this._device;
    }

    set device(device) {
        if (this.device === device)
            return;

        this._device = device;
    }

    get uuid() {
        if (this._uuid === undefined)
            this._uuid = GLib.uuid_string_random();

        return this._uuid;
    }

    /**
     * Ensure there is a stream for the transfer item.
     *
     * @param {Object} item - A transfer item
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     */
    async _ensureStream(item, cancellable = null) {
        // This is an upload from a remote device
        if (item.packet.hasPayload()) {
            if (item.target instanceof Gio.OutputStream)
                return;

            if (item.file instanceof Gio.File) {
                item.target = await new Promise((resolve, reject) => {
                    item.file.replace_async(
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        GLib.PRIORITY_DEFAULT,
                        this._cancellable,
                        (file, res) => {
                            try {
                                resolve(file.replace_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });
            }
        } else {
            if (item.source instanceof Gio.InputStream)
                return;

            if (item.file instanceof Gio.File) {
                const read = new Promise((resolve, reject) => {
                    item.file.read_async(
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                        (file, res) => {
                            try {
                                resolve(file.read_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                const query = new Promise((resolve, reject) => {
                    item.file.query_info_async(
                        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                        (file, res) => {
                            try {
                                resolve(file.query_info_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                const [stream, info] = await Promise.all([read, query]);
                item.source = stream;
                item.size = info.get_size();
            }
        }
    }

    /**
     * Add a file to the transfer.
     *
     * @param {Core.Packet} packet - A packet
     * @param {Gio.File} file - A file to transfer
     */
    addFile(packet, file) {
        const item = {
            packet: new Packet(packet),
            file: file,
            source: null,
            target: null,
        };

        this._items.push(item);
    }

    /**
     * Add a filepath to the transfer.
     *
     * @param {Core.Packet} packet - A packet
     * @param {string} path - A filepath to transfer
     */
    addPath(packet, path) {
        const item = {
            packet: new Packet(packet),
            file: Gio.File.new_for_path(path),
            source: null,
            target: null,
        };

        this._items.push(item);
    }

    /**
     * Add a stream to the transfer.
     *
     * @param {Core.Packet} packet - A packet
     * @param {Gio.InputStream|Gio.OutputStream} stream - A stream to transfer
     * @param {number} [size] - Payload size
     */
    addStream(packet, stream, size = 0) {
        const item = {
            packet: new Packet(packet),
            file: null,
            source: null,
            target: null,
            size: size,
        };

        if (stream instanceof Gio.InputStream)
            item.source = stream;
        else if (stream instanceof Gio.OutputStream)
            item.target = stream;

        this._items.push(item);
    }

    /**
     * Execute a transfer operation. Implementations may override this, while
     * the default uses g_output_stream_splice().
     *
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     */
    async start(cancellable = null) {
        let error = null;

        try {
            let item;

            // If a cancellable is passed in, chain to its signal
            if (cancellable instanceof Gio.Cancellable)
                cancellable.connect(() => this._cancellable.cancel());

            while ((item = this._items.shift())) {
                // If created for a device, ignore connection changes by
                // ensuring we have the most recent channel
                if (this.device !== null)
                    this._channel = this.device.channel;

                // TODO: transfer queueing?
                if (this.channel === null || this.channel.closed) {
                    throw new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                        message: 'Channel is closed',
                    });
                }

                await this._ensureStream(item, this._cancellable);

                if (item.packet.hasPayload()) {
                    await this.channel.download(item.packet, item.target,
                        this._cancellable);
                } else {
                    await this.channel.upload(item.packet, item.source,
                        item.size, this._cancellable);
                }
            }
        } catch (e) {
            error = e;
        } finally {
            this._completed = true;
            this.notify('completed');
        }

        if (error !== null)
            throw error;
    }

    cancel() {
        if (this._cancellable.is_cancelled() === false)
            this._cancellable.cancel();
    }
});

