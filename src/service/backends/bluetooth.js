// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Device from '../device.js';
import * as DBus from '../utils/dbus.js';

const BLUEZ_SERVICE = 'org.bluez';
const BLUEZ_OBJECT = '/';
const BLUEZ_PROFILE_MANAGER_OBJECT = '/org/bluez';
const BLUEZ_PROFILE_MANAGER_IFACE = 'org.bluez.ProfileManager1';
const BLUEZ_DEVICE_IFACE = 'org.bluez.Device1';

const PROFILE_OBJECT = '/org/gnome/Shell/Extensions/GSConnect/BluetoothProfile';
const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
const SERVICE_UUID_HEX = '185f3df432684e3f9fcad4d5059915bd';
const DEFAULT_CHANNEL_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
const SCAN_INTERVAL_SECONDS = 15;
const BUFFER_SIZE = 4096;

const MESSAGE_PROTOCOL_VERSION = 0;
const MESSAGE_OPEN_CHANNEL = 1;
const MESSAGE_CLOSE_CHANNEL = 2;
const MESSAGE_READ = 3;
const MESSAGE_WRITE = 4;

const PROFILE_XML = `
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="fd_properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="device" type="o" direction="in"/>
    </method>
  </interface>
</node>
`;

function _normalizeAddress(address = '') {
    return address.toUpperCase();
}

function _property(proxy, name, fallback = null) {
    const property = proxy.get_cached_property(name);

    if (property === null)
        return fallback;

    return property.recursiveUnpack();
}

function _deviceSettings(deviceId) {
    return new Gio.Settings({
        settings_schema: Config.GSCHEMA.lookup(
            'org.gnome.Shell.Extensions.GSConnect.Device',
            true
        ),
        path: `/org/gnome/shell/extensions/gsconnect/device/${deviceId}/`,
    });
}

function _uuidToBytes(uuid) {
    const normalized = uuid.replace(/-/g, '');
    const bytes = new Uint8Array(16);

    for (let i = 0; i < 16; i++)
        bytes[i] = Number.parseInt(normalized.slice(i * 2, (i * 2) + 2), 16);

    return bytes;
}

function _bytesToUuid(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

function _encodeMessage(type, uuid, payload = null) {
    const data = payload ?? new Uint8Array(0);
    const message = new Uint8Array(19 + data.length);
    const view = new DataView(message.buffer);

    message[0] = type;
    view.setUint16(1, data.length, false);
    message.set(_uuidToBytes(uuid), 3);
    message.set(data, 19);

    return message;
}

class MultiplexChannelState {

    constructor(uuid) {
        this.uuid = uuid;
        this.connected = true;
        this.readBuffer = [];
        this.readLength = 0;
        this.requestedReadAmount = 0;
        this.freeWriteAmount = 0;
        this.readWaiters = [];
        this.writeWaiters = [];
    }
}

class ConnectionMultiplexer {

    constructor(connection) {
        this._connection = connection;
        this._input = connection.get_input_stream();
        this._output = connection.get_output_stream();
        this._channels = new Map();
        this._channelWaiters = new Map();
        this._writeChain = Promise.resolve();
        this._closed = false;
        this._lineBuffer = '';
        this._lineDecoder = new TextDecoder();
        this._lineEncoder = new TextEncoder();

        this._ensureChannel(DEFAULT_CHANNEL_UUID);
        this._queueMessage(_encodeMessage(
            MESSAGE_PROTOCOL_VERSION,
            '00000000-0000-0000-0000-000000000000',
            new Uint8Array([0, 1, 0, 1])
        ));

        this._requestRead(this._channels.get(DEFAULT_CHANNEL_UUID));
    }

    _ensureChannel(uuid) {
        if (this._channels.has(uuid))
            return this._channels.get(uuid);

        const channel = new MultiplexChannelState(uuid);
        this._channels.set(uuid, channel);

        const waiters = this._channelWaiters.get(uuid) ?? [];
        waiters.forEach(resolve => resolve(channel));
        this._channelWaiters.delete(uuid);

        this._requestRead(channel);

        return channel;
    }

    _getChannel(uuid) {
        return this._channels.get(uuid) ?? null;
    }

    _waitChannel(uuid, cancellable = null) {
        const channel = this._getChannel(uuid);

        if (channel)
            return channel;

        return new Promise((resolve, reject) => {
            const list = this._channelWaiters.get(uuid) ?? [];
            list.push(resolve);
            this._channelWaiters.set(uuid, list);

            if (cancellable instanceof Gio.Cancellable) {
                const id = cancellable.connect(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled while waiting for channel',
                    }));
                    cancellable.disconnect(id);
                });
            }
        });
    }

    _readExact(length, cancellable = null) {
        const chunks = [];
        let total = 0;

        return new Promise((resolve, reject) => {
            const loop = () => {
                if (this._closed) {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                        message: 'Bluetooth multiplexer closed',
                    }));
                    return;
                }

                this._input.read_bytes_async(
                    length - total,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                    (stream, res) => {
                        try {
                            const bytes = stream.read_bytes_finish(res);
                            const array = bytes.toArray();

                            if (array.length === 0) {
                                reject(new Gio.IOErrorEnum({
                                    code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                                    message: 'End of stream',
                                }));
                                return;
                            }

                            chunks.push(array);
                            total += array.length;

                            if (total >= length) {
                                const merged = new Uint8Array(total);
                                let offset = 0;

                                for (const chunk of chunks) {
                                    merged.set(chunk, offset);
                                    offset += chunk.length;
                                }

                                resolve(merged.slice(0, length));
                            } else {
                                loop();
                            }
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            };

            loop();
        });
    }

    _queueMessage(message, cancellable = null) {
        this._writeChain = this._writeChain.then(async () => {
            if (this._closed)
                return;

            await this._output.write_all_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
        });

        return this._writeChain;
    }

    _wakeReadWaiters(channel) {
        while (channel.readWaiters.length)
            channel.readWaiters.shift()();
    }

    _wakeWriteWaiters(channel) {
        while (channel.writeWaiters.length)
            channel.writeWaiters.shift()();
    }

    _requestRead(channel) {
        if (!channel || !channel.connected)
            return;

        const amount = BUFFER_SIZE - channel.readLength - channel.requestedReadAmount;

        if (amount <= 0)
            return;

        channel.requestedReadAmount += amount;

        const payload = new Uint8Array(2);
        new DataView(payload.buffer).setUint16(0, amount, false);
        this._queueMessage(_encodeMessage(MESSAGE_READ, channel.uuid, payload)).catch(e => {
            debug(e, 'Bluetooth Multiplexer Read Request');
        });
    }

    async _waitForReadable(channel, cancellable = null) {
        if (channel.readLength > 0)
            return;

        if (!channel.connected) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                message: 'Bluetooth channel closed',
            });
        }

        await new Promise((resolve, reject) => {
            channel.readWaiters.push(resolve);

            if (cancellable instanceof Gio.Cancellable) {
                const id = cancellable.connect(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled while waiting for payload data',
                    }));
                    cancellable.disconnect(id);
                });
            }
        });
    }

    async _waitForWritable(channel, cancellable = null) {
        if (channel.freeWriteAmount > 0)
            return;

        if (!channel.connected) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                message: 'Bluetooth channel closed',
            });
        }

        await new Promise((resolve, reject) => {
            channel.writeWaiters.push(resolve);

            if (cancellable instanceof Gio.Cancellable) {
                const id = cancellable.connect(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled while waiting for write credits',
                    }));
                    cancellable.disconnect(id);
                });
            }
        });
    }

    _pushReadData(channel, data) {
        if (!channel.connected)
            return;

        channel.readBuffer.push(data);
        channel.readLength += data.length;
        this._wakeReadWaiters(channel);
    }

    _popReadData(channel, amount) {
        const out = new Uint8Array(amount);
        let offset = 0;

        while (offset < amount && channel.readBuffer.length > 0) {
            const chunk = channel.readBuffer[0];
            const copy = Math.min(chunk.length, amount - offset);

            out.set(chunk.slice(0, copy), offset);
            offset += copy;

            if (copy === chunk.length)
                channel.readBuffer.shift();
            else
                channel.readBuffer[0] = chunk.slice(copy);
        }

        channel.readLength -= offset;

        return out.slice(0, offset);
    }

    async read(uuid, amount, cancellable = null) {
        const channel = await this._waitChannel(uuid, cancellable);

        while (channel.readLength < amount && channel.connected) {
            this._requestRead(channel);
            await this._waitForReadable(channel, cancellable);
        }

        if (channel.readLength === 0 && !channel.connected) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                message: 'Bluetooth channel closed',
            });
        }

        return this._popReadData(channel, Math.min(amount, channel.readLength));
    }

    async readLine(cancellable = null) {
        let index = this._lineBuffer.indexOf('\n');

        while (index === -1) {
            const data = await this.read(DEFAULT_CHANNEL_UUID, 1, cancellable);
            this._lineBuffer += this._lineDecoder.decode(data, {stream: true});
            index = this._lineBuffer.indexOf('\n');
        }

        const line = this._lineBuffer.slice(0, index + 1);
        this._lineBuffer = this._lineBuffer.slice(index + 1);

        return line;
    }

    async write(uuid, data, cancellable = null) {
        const channel = await this._waitChannel(uuid, cancellable);

        let offset = 0;

        while (offset < data.length) {
            await this._waitForWritable(channel, cancellable);

            const amount = Math.min(
                data.length - offset,
                channel.freeWriteAmount,
                BUFFER_SIZE
            );

            if (amount <= 0)
                continue;

            channel.freeWriteAmount -= amount;

            const chunk = data.slice(offset, offset + amount);
            await this._queueMessage(
                _encodeMessage(MESSAGE_WRITE, uuid, chunk),
                cancellable
            );

            offset += amount;
        }
    }

    openChannel() {
        const uuid = GLib.uuid_string_random();

        this._ensureChannel(uuid);
        this._queueMessage(_encodeMessage(MESSAGE_OPEN_CHANNEL, uuid)).catch(e => {
            debug(e, 'Bluetooth Multiplexer Open Channel');
        });

        return uuid;
    }

    closeChannel(uuid) {
        const channel = this._channels.get(uuid);

        if (!channel)
            return;

        channel.connected = false;
        channel.readBuffer = [];
        channel.readLength = 0;

        this._wakeReadWaiters(channel);
        this._wakeWriteWaiters(channel);

        this._queueMessage(_encodeMessage(MESSAGE_CLOSE_CHANNEL, uuid)).catch(e => {
            debug(e, 'Bluetooth Multiplexer Close Channel');
        });

        this._channels.delete(uuid);
    }

    async start(cancellable = null) {
        while (!this._closed) {
            const header = await this._readExact(19, cancellable);
            const type = header[0];
            const length = new DataView(header.buffer).getUint16(1, false);
            const uuid = _bytesToUuid(header.slice(3, 19));
            const data = (length > 0)
                ? await this._readExact(length, cancellable)
                : new Uint8Array(0);

            if (type === MESSAGE_OPEN_CHANNEL) {
                this._ensureChannel(uuid);
                continue;
            }

            if (type === MESSAGE_CLOSE_CHANNEL) {
                const channel = this._channels.get(uuid);

                if (channel) {
                    channel.connected = false;
                    this._wakeReadWaiters(channel);
                    this._wakeWriteWaiters(channel);
                    this._channels.delete(uuid);
                }

                continue;
            }

            if (type === MESSAGE_READ) {
                const channel = this._channels.get(uuid);

                if (!channel)
                    continue;

                const amount = new DataView(data.buffer).getUint16(0, false);
                channel.freeWriteAmount += amount;
                this._wakeWriteWaiters(channel);
                continue;
            }

            if (type === MESSAGE_WRITE) {
                const channel = this._channels.get(uuid);

                if (!channel)
                    continue;

                channel.requestedReadAmount = Math.max(0,
                    channel.requestedReadAmount - data.length);
                this._pushReadData(channel, data);
                this._requestRead(channel);
                continue;
            }

            if (type === MESSAGE_PROTOCOL_VERSION)
                continue;
        }
    }

    stop() {
        if (this._closed)
            return;

        this._closed = true;

        for (const channel of this._channels.values()) {
            channel.connected = false;
            this._wakeReadWaiters(channel);
            this._wakeWriteWaiters(channel);
        }

        this._channels.clear();
    }

    async writePacket(packet, cancellable = null) {
        const data = this._lineEncoder.encode(packet.serialize());
        await this.write(DEFAULT_CHANNEL_UUID, data, cancellable);
    }
}

export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
}, class BluetoothChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        this._allowed = new Set();
        this._connecting = new Set();
        this._signalIds = [];
        this._profile = null;
        this._scanId = 0;
        this._systemBus = null;
        this._objectManager = null;
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    get certificate() {
        if (this._certificate === undefined) {
            const certPath = GLib.build_filenamev([
                Config.CONFIGDIR,
                'certificate.pem',
            ]);
            const keyPath = GLib.build_filenamev([
                Config.CONFIGDIR,
                'private.pem',
            ]);

            this._certificate = Gio.TlsCertificate.new_for_paths(
                certPath,
                keyPath,
                null
            );
        }

        return this._certificate;
    }

    buildIdentity() {
        super.buildIdentity();

        if (this.certificate?.certificate_pem)
            this._identity.body.certificate = this.certificate.certificate_pem;
    }

    async _registerProfile() {
        const info = Gio.DBusNodeInfo.new_for_xml(PROFILE_XML);

        this._profile = new DBus.Interface({
            g_instance: this,
            g_interface_info: info.interfaces[0],
        });

        this._profile.export(this._systemBus, PROFILE_OBJECT);

        const proxy = new Gio.DBusProxy({
            g_connection: this._systemBus,
            g_name: BLUEZ_SERVICE,
            g_object_path: BLUEZ_PROFILE_MANAGER_OBJECT,
            g_interface_name: BLUEZ_PROFILE_MANAGER_IFACE,
            g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        });
        await proxy.init_async(GLib.PRIORITY_DEFAULT, this.cancellable);

        const options = {
            Name: new GLib.Variant('s', 'GSConnect'),
            Role: new GLib.Variant('s', 'server'),
            AutoConnect: new GLib.Variant('b', true),
            // Android uses a secure RFCOMM socket for KDE Connect.
            // Match KDE's encrypted/authenticated transport expectations.
            RequireAuthentication: new GLib.Variant('b', true),
            RequireAuthorization: new GLib.Variant('b', false),
        };

        await proxy.call(
            'RegisterProfile',
            new GLib.Variant('(osa{sv})', [PROFILE_OBJECT, SERVICE_UUID, options]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );
    }

    async _unregisterProfile() {
        if (this._systemBus === null || this._profile === null)
            return;

        try {
            const proxy = new Gio.DBusProxy({
                g_connection: this._systemBus,
                g_name: BLUEZ_SERVICE,
                g_object_path: BLUEZ_PROFILE_MANAGER_OBJECT,
                g_interface_name: BLUEZ_PROFILE_MANAGER_IFACE,
                g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            });
            await proxy.init_async(GLib.PRIORITY_DEFAULT, this.cancellable);

            await proxy.call(
                'UnregisterProfile',
                new GLib.Variant('(o)', [PROFILE_OBJECT]),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (e) {
            debug(e, 'Bluetooth Profile Unregister');
        }

        this._profile.destroy();
        this._profile = null;
    }

    _isKdeConnectDevice(proxy) {
        const uuids = _property(proxy, 'UUIDs', [])
            .map(uuid => uuid.toLowerCase());

        return uuids.includes(SERVICE_UUID) || uuids.includes(SERVICE_UUID_HEX);
    }

    _iterDeviceProxies() {
        const objects = this._objectManager?.get_objects() ?? [];

        return objects
            .map(object => object.get_interface(BLUEZ_DEVICE_IFACE))
            .filter(proxy => proxy instanceof Gio.DBusProxy);
    }

    async _connectProxy(proxy) {
        const address = _normalizeAddress(_property(proxy, 'Address', ''));

        if (!address)
            return;

        if (this.channels.has(`bluetooth://${address}`))
            return;

        if (this._connecting.has(address))
            return;

        this._connecting.add(address);

        try {
            await proxy.call(
                'ConnectProfile',
                new GLib.Variant('(s)', [SERVICE_UUID]),
                Gio.DBusCallFlags.NONE,
                -1,
                this.cancellable
            );
        } catch (e) {
            debug(e, `Bluetooth ConnectProfile (${address})`);
        } finally {
            this._connecting.delete(address);
        }
    }

    async _scanDevices(address = null) {
        if (this._objectManager === null)
            return;

        const target = address ? _normalizeAddress(address) : null;

        for (const proxy of this._iterDeviceProxies()) {
            const current = _normalizeAddress(_property(proxy, 'Address', ''));

            if (target !== null && current !== target)
                continue;

            if (!_property(proxy, 'Paired', false))
                continue;

            if (!this._isKdeConnectDevice(proxy))
                continue;

            await this._connectProxy(proxy);
        }
    }

    _onObjectAdded(_manager, object) {
        const proxy = object.get_interface(BLUEZ_DEVICE_IFACE);

        if (!(proxy instanceof Gio.DBusProxy))
            return;

        if (!_property(proxy, 'Paired', false))
            return;

        if (!this._isKdeConnectDevice(proxy))
            return;

        this._connectProxy(proxy).catch(e => {
            debug(e, 'Bluetooth Object Added');
        });
    }

    async _start() {
        this.buildIdentity();

        this._systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, this.cancellable);

        this._objectManager = Gio.DBusObjectManagerClient.new_for_bus_sync(
            Gio.BusType.SYSTEM,
            Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
            BLUEZ_SERVICE,
            BLUEZ_OBJECT,
            null,
            null
        );

        this._signalIds.push(this._objectManager.connect(
            'object-added',
            this._onObjectAdded.bind(this)
        ));

        await this._registerProfile();

        this._scanId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            SCAN_INTERVAL_SECONDS,
            () => {
                this.broadcast();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._active = true;
        this.notify('active');

        await this._scanDevices();
    }

    NewConnection(device, fd) {
        const proxy = this._objectManager?.get_object(device)
            ?.get_interface(BLUEZ_DEVICE_IFACE);
        const address = _normalizeAddress(_property(proxy, 'Address', ''));

        const channel = new Channel({
            backend: this,
            address,
            device,
            allowed: this._allowed.has(address),
        });

        channel.accept(fd).then(() => {
            const existing = this.channels.get(channel.address);
            if (existing)
                existing.close();

            this.channels.set(channel.address, channel);
            this.channel(channel);
        }).catch(e => {
            debug(e, `Bluetooth NewConnection (${channel.address})`);
            channel.close();
        });
    }

    RequestDisconnection(device) {
        const proxy = this._objectManager?.get_object(device)
            ?.get_interface(BLUEZ_DEVICE_IFACE);
        const address = _normalizeAddress(_property(proxy, 'Address', ''));

        this.channels.get(`bluetooth://${address}`)?.close();
    }

    Release() {
    }

    broadcast(address = null) {
        if (address !== null)
            this._allowed.add(_normalizeAddress(address));

        this._scanDevices(address).catch(e => {
            debug(e, 'Bluetooth Scan');
        });
    }

    start() {
        if (this.active)
            return;

        this._start().catch(e => {
            logError(e);
            this.stop();
        });
    }

    stop() {
        if (!this.active && this._scanId === 0)
            return;

        if (this._scanId > 0) {
            GLib.Source.remove(this._scanId);
            this._scanId = 0;
        }

        for (const id of this._signalIds)
            this._objectManager?.disconnect(id);
        this._signalIds = [];

        for (const channel of this.channels.values())
            channel.close();

        this.channels.clear();
        this._allowed.clear();
        this._objectManager = null;

        this._unregisterProfile().catch(e => {
            debug(e, 'Bluetooth Stop');
        });

        this._systemBus = null;

        this._active = false;
        this.notify('active');
    }

    destroy() {
        try {
            this.stop();
            this.cancellable.cancel();
        } catch (e) {
            debug(e);
        }
    }
});

export const Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {

    _init(params = {}) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `bluetooth://${this._address ?? 'unknown'}`;
    }

    set address(address) {
        this._address = address;
    }

    get peer_certificate() {
        if (this._peerCertificate === undefined)
            this._peerCertificate = null;

        return this._peerCertificate;
    }

    _attachSocket(fd) {
        const socket = Gio.Socket.new_from_fd(fd);

        this._connection = Gio.SocketConnection.factory_create_connection(socket);
        this._multiplexer = new ConnectionMultiplexer(this._connection);
        this._multiplexer.start(this.cancellable).catch(e => {
            debug(e, 'Bluetooth Multiplexer Loop');
            this.close();
        });
    }

    _validateIdentity() {
        if (!this.identity.body.deviceId)
            throw new Error('missing deviceId');

        if (!Device.validateId(this.identity.body.deviceId))
            throw new Error(`invalid deviceId "${this.identity.body.deviceId}"`);

        if (!this.identity.body.deviceName)
            throw new Error('missing deviceName');

        if (!Device.validateName(this.identity.body.deviceName)) {
            const sanitized = Device.sanitizeName(this.identity.body.deviceName);
            debug(`Sanitized invalid device name "${this.identity.body.deviceName}" to "${sanitized}"`);
            this.identity.body.deviceName = sanitized;
        }

        if (!this.identity.body.certificate)
            throw new Error('missing certificate');

        this._peerCertificate = Gio.TlsCertificate.new_from_pem(
            this.identity.body.certificate,
            -1
        );

        const settings = _deviceSettings(this.identity.body.deviceId);
        const certPem = settings.get_string('certificate-pem');

        if (!certPem)
            return;

        const known = Gio.TlsCertificate.new_from_pem(certPem, -1);

        if (!known.is_same(this._peerCertificate)) {
            settings.reset('paired');
            settings.reset('certificate-pem');
            throw new Error('Authentication Failure');
        }
    }

    async _exchangeIdentity() {
        await this.sendPacket(this.backend.identity);

        this.identity = await this.readPacket();

        if (this.identity.type !== 'kdeconnect.identity')
            throw new Error(`Unexpected packet type "${this.identity.type}"`);

        if (this.identity.body.protocolVersion !== this.backend.identity.body.protocolVersion) {
            throw new Error(
                `Unexpected protocol version ${this.identity.body.protocolVersion}; ` +
                `expected ${this.backend.identity.body.protocolVersion}`
            );
        }

        this._validateIdentity();

        if (!this._address && this.identity.body.bluetoothAddress)
            this._address = _normalizeAddress(this.identity.body.bluetoothAddress);
    }

    async accept(fd) {
        debug(`${this.address} (${this.uuid})`);

        try {
            this._attachSocket(fd);
            await this._exchangeIdentity();
        } catch (e) {
            this.close();
            throw e;
        }
    }

    async readPacket(cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const line = await this._multiplexer.readLine(cancellable);
        return new Core.Packet(line);
    }

    async sendPacket(packet, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        await this._multiplexer.writePacket(packet, cancellable);
        return true;
    }

    close() {
        if (this.closed)
            return;

        this._closed = true;
        this.notify('closed');

        this.cancellable.cancel();

        this.backend.channels.delete(this.address);

        this._multiplexer?.stop();
        this._connection?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this.input_stream?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this.output_stream?.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    async download(packet, target, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const transferInfo = packet.payloadTransferInfo ?? {};
        const transferUuid = transferInfo.uuid;

        if (!transferUuid) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.INVALID_ARGUMENT,
                message: 'Missing bluetooth payload transfer UUID',
            });
        }

        let remaining = packet.payloadSize;

        while (remaining > 0) {
            const chunkSize = Math.min(BUFFER_SIZE, remaining);
            const chunk = await this._multiplexer.read(transferUuid, chunkSize, cancellable);

            await target.write_all_async(
                chunk,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );

            remaining -= chunk.length;
        }

        this._multiplexer.closeChannel(transferUuid);
    }

    async upload(packet, source, size, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const transferUuid = this._multiplexer.openChannel();

        packet.payloadSize = size;
        packet.payloadTransferInfo = {
            uuid: transferUuid,
        };

        await this.sendPacket(new Core.Packet(packet), cancellable);

        let transferred = 0;

        while (transferred < size) {
            const bytes = await source.read_bytes_async(
                Math.min(BUFFER_SIZE, size - transferred),
                GLib.PRIORITY_DEFAULT,
                cancellable
            );

            const chunk = bytes.toArray();

            if (chunk.length === 0)
                break;

            await this._multiplexer.write(transferUuid, chunk, cancellable);
            transferred += chunk.length;
        }

        this._multiplexer.closeChannel(transferUuid);

        if (transferred !== size) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PARTIAL_INPUT,
                message: `Transfer incomplete: ${transferred}/${size}`,
            });
        }
    }

    rejectTransfer(packet) {
        const transferUuid = packet?.payloadTransferInfo?.uuid;

        if (!transferUuid)
            return;

        this._multiplexer.closeChannel(transferUuid);
    }
});
