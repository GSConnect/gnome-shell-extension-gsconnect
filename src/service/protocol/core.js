'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


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

        if (typeof data === 'string') {
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

    get service() {
        return Gio.Application.get_default();
    }

    get type() {
        return null;
    }

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
     * Override these to send and receive the identity packet during initial
     * connection negotiation.
     */
    _receiveIdent(connection) {
        throw new GObject.NotImplementedError();
    }

    _sendIdent(connection) {
        throw new GObject.NotImplementedError();
    }

    accept(connection) {
        throw new GObject.NotImplementedError();
    }

    open(connection) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Attach to @device as the default channel used for packet exchange. This
     * should connect the channel's Gio.Cancellable to mark the device as
     * disconnected, setup the IO streams, start the receive() loop and set the
     * device as connected.
     *
     * @param {Device.Device} device - The device to attach to
     */
    attach(device) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        throw new GObject.NotImplementedError();
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
                try {
                    let data = stream.read_line_finish_utf8(res)[0];

                    if (data === null) {
                        throw new Error('End of stream');
                    }

                    // Queue another receive() before handling the packet
                    this.receive(device);

                    // Malformed packets aren't fatal
                    try {
                        let packet = new Packet(data);
                        debug(packet, device.name);
                        device.receivePacket(packet);
                    } catch (e) {
                        warning(e);
                    }
                } catch (e) {
                    debug(e, device.name);
                    this.close();
                }
            }
        );
    }

    /**
     * Send a packet to a device
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
                    await new Promise((resolve, reject) => {
                        this.output_stream.write_all_async(
                            next.toString(),
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

                    debug(next, this.identity.body.deviceName);
                }

                this.__lock = false;
            }
        } catch (e) {
            debug(e, this.identity.body.deviceName);
            this.close();
        }
    }

    /**
     * Override these in subclasses to negotiate payload transfers. Both methods
     * should cleanup after themselves and return a success boolean.
     *
     * The default implementation will always report failure, for protocols that
     * won't or don't yet support payload transfers.
     */
    async download(packet) {
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

    async upload(port) {
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
};

