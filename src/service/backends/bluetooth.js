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
const SCAN_INTERVAL_SECONDS = 15;

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

function _loadSdpRecord() {
    const path = '/org/gnome/Shell/Extensions/GSConnect/' +
        'org.gnome.Shell.Extensions.GSConnect.sdp.xml';
    const bytes = Gio.resources_lookup_data(path, Gio.ResourceLookupFlags.NONE);
    return new TextDecoder().decode(bytes.toArray());
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
            ServiceRecord: new GLib.Variant('s', _loadSdpRecord()),
            AutoConnect: new GLib.Variant('b', true),
            RequireAuthentication: new GLib.Variant('b', false),
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

    _onObjectAdded(manager, object) {
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

    async NewConnection(device, fd) {
        const proxy = this._objectManager?.get_object(device)
            ?.get_interface(BLUEZ_DEVICE_IFACE);
        const address = _normalizeAddress(_property(proxy, 'Address', ''));

        const channel = new Channel({
            backend: this,
            address,
            device,
            allowed: this._allowed.has(address),
        });

        try {
            await channel.accept(fd);

            const existing = this.channels.get(channel.address);
            if (existing)
                existing.close();

            this.channels.set(channel.address, channel);
            this.channel(channel);
        } catch (e) {
            channel.close();
            throw e;
        }
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
        this.input_stream = this._connection.get_input_stream();
        this.output_stream = this._connection.get_output_stream();
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

    close() {
        if (this.closed)
            return;

        this._closed = true;
        this.notify('closed');

        this.cancellable.cancel();

        this.backend.channels.delete(this.address);

        this._connection?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this.input_stream?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this.output_stream?.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    download(_packet, _target, _cancellable = null) {
        throw new Gio.IOErrorEnum({
            code: Gio.IOErrorEnum.NOT_SUPPORTED,
            message: 'Bluetooth payload transfers are not yet supported',
        });
    }

    upload(_packet, _source, _size, _cancellable = null) {
        throw new Gio.IOErrorEnum({
            code: Gio.IOErrorEnum.NOT_SUPPORTED,
            message: 'Bluetooth payload transfers are not yet supported',
        });
    }

    async rejectTransfer(_packet) {
    }
});
