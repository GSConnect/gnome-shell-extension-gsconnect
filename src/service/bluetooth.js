'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;
const DBus = imports.service.components.dbus;


/**
 * org.bluez Interfaces
 */
var BluezNode = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.ProfileManager1">
    <method name="RegisterProfile">
      <arg name="profile" type="o" direction="in"/>
      <arg name="UUID" type="s" direction="in"/>
      <arg name="options" type="a{sv}" direction="in"/>
    </method>
    <method name="UnregisterProfile">
      <arg name="profile" type="o" direction="in"/>
    </method>
  </interface>

  <!-- Device (eg. /org/bluez/hci0/dev_00_00_00_00_00_00) -->
  <interface name="org.bluez.Device1">
    <!-- Methods -->
    <method name="Disconnect"/>
    <method name="Connect"/>
    <method name="ConnectProfile">
      <arg name="UUID" type="s" direction="in"/>
    </method>
    <method name="DisconnectProfile">
      <arg name="UUID" type="s" direction="in"/>
    </method>
    <method name="Pair"/>
    <method name="CancelPairing"/>
    <!-- Properties -->
    <property name="Address" type="s" access="read"/>
    <property name="AddressType" type="s" access="read"/>
    <property name="Name" type="s" access="read"/>
    <property name="Alias" type="s" access="readwrite"/>
    <property name="Class" type="u" access="read"/>
    <property name="Appearance" type="q" access="read"/>
    <property name="Icon" type="s" access="read"/>
    <property name="Paired" type="b" access="read"/>
    <property name="Trusted" type="b" access="readwrite"/>
    <property name="Blocked" type="b" access="readwrite"/>
    <property name="LegacyPairing" type="b" access="read"/>
    <property name="RSSI" type="n" access="read"/>
    <property name="Connected" type="b" access="read"/>
    <property name="UUIDs" type="as" access="read"/>
    <property name="Modalias" type="s" access="read"/>
    <property name="Adapter" type="o" access="read"/>
    <property name="ManufacturerData" type="a{qv}" access="read"/>
    <property name="ServiceData" type="a{sv}" access="read"/>
    <property name="TxPower" type="n" access="read"/>
    <property name="ServicesResolved" type="b" access="read"/>
  </interface>

  <!-- Profile (to be exported) -->
  <interface name="org.bluez.Profile1">
    <!-- Methods -->
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="fd_properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="object_path" type="o" direction="in"/>
    </method>
  </interface>
</node>
`);


/**
 * Proxy for org.bluez.Adapter1 interface
 */
const DEVICE_INFO = BluezNode.lookup_interface('org.bluez.Device1');
const PROFILE_MANAGER_INFO = BluezNode.lookup_interface('org.bluez.ProfileManager1');

const ProfileManager1Proxy = DBus.makeInterfaceProxy(PROFILE_MANAGER_INFO);


/**
 * Service Discovery Protocol Record template
 */
const SDP_TEMPLATE = Gio.resources_lookup_data(
    gsconnect.app_path + '/' + gsconnect.app_id + '.sdp.xml',
    Gio.ResourceLookupFlags.NONE
).toArray().toString();


function makeSdpRecord(uuid) {
    return SDP_TEMPLATE.replace(
        /@UUID@/gi,
        uuid
    ).replace(
        '@UUID_ANDROID@',
        uuid.replace(/\-/gi, '')
    );
};


/**
 * KDE Connect Service UUID & SDP
 */
const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';


/**
 * Bluez Channel Service
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Properties: {
        'devices': GObject.param_spec_variant(
            'devices',
            'DevicesList',
            'A list of known devices',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class ChannelService extends Gio.DBusObjectManagerClient {

    _init() {
        super._init({
            connection: Gio.DBus.system,
            name: 'org.bluez',
            object_path: '/'
        });

        // The full device map
        this._devices = new Map();

        // Asynchronous init
        this._init_async();
    }

    // A list of device proxies supporting the KDE Connect Service UUID
    get devices() {
        let devices = Array.from(this._devices.values());
        return devices.filter(device => device.UUIDs.includes(SERVICE_UUID));
    }

    get service() {
        return Gio.Application.get_default();
    }

    /**
     * Create a service record and register a profile
     *
     *
     */
    async _register(uuid) {
        try {
            // Export the org.bluez.Profile1 interface for the KDE Connect service
            this._profile = new DBus.Interface({
                g_connection: Gio.DBus.system,
                g_instance: this,
                g_interface_info: BluezNode.lookup_interface('org.bluez.Profile1'),
                g_object_path: gsconnect.app_path + uuid.replace(/\-/gi, '')
            });

            // Register our exported profile path
            let profile = this._profile.get_object_path();

            // Set profile options
            let options = {
                // Don't require confirmation
                RequireAuthorization: new GLib.Variant('b', false),
                // Only allow paired devices
                RequireAuthentication: new GLib.Variant('b', true),
                // Service Record (customized to work with Android)
                ServiceRecord: new GLib.Variant('s', makeSdpRecord(uuid))
            };

            // Register KDE Connect bluez profile
            await this._profileManager.RegisterProfile(profile, uuid, options);
        } catch (e) {
            logError(e);
        }
    }

    async _init_async() {
        try {
            await new Promise((resolve, reject) => {
                this.init_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        obj.init_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Get a ProfileManager
            this._profileManager = new ProfileManager1Proxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.bluez',
                g_object_path: '/org/bluez'
            });

            await this._profileManager.init_promise();

            // Register the service profile
            await this._register(SERVICE_UUID);

            for (let obj of this.get_objects()) {
                for (let iface of obj.get_interfaces()) {
                    this.vfunc_interface_added(obj, iface);
                }
            }
        } catch (e) {
            logWarning(e, 'Bluetooth.ChannelService');
        }
    }

    vfunc_interface_added(object, iface) {
        // We track all devices in case their service UUIDs change later
        if (iface.g_interface_name === 'org.bluez.Device1') {
            // Setup the device proxy
            DBus.proxyMethods(iface, DEVICE_INFO);
            DBus.proxyProperties(iface, DEVICE_INFO);
            iface._channel = null;

            this._devices.set(iface.g_object_path, iface);

            // Notify and try connecting the new device
            this.notify('devices');
            this._connectDevice(iface);
        }
    }

    vfunc_interface_removed(manager, object, iface) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            this.RequestDisconnection(iface.g_object_path);
            this._devices.delete(iface.g_object_path);
        }
    }

    vfunc_interface_proxy_properties_changed(object, iface, changed, invalidated) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            changed = changed.full_unpack();

            switch (true) {
                // Try connecting if the device has just connected or resolved services
                case changed.Connected:
                case changed.ServicesResolved:
                    this._connectDevice(iface);
                    break;

                case (changed.Connected === false):
                    this.RequestDisconnection(iface.g_object_path);
                    break;
            }
        }
    }

    /**
     * Attempt to connect the service profile to @iface
     *
     * @param {Gio.DBusProxy} iface - A org.bluez.Device1 interface proxy
     */
    async _connectDevice(iface) {
        try {
            // This device already has a connected or connecting channel
            if (iface._channel !== null) {
                debug('already connected', iface.Alias);
                return;
            }

            // Only try connecting paired bluetooth devices
            if (iface.Paired) {
                debug('requesting bluetooth connection', iface.Alias);
                await iface.ConnectProfile(SERVICE_UUID);
            }
        } catch (e) {
            debug(e, iface.Alias);
        }
    }

    /**
     * This method gets called when the service daemon unregisters the profile.
     * A profile can use it to do cleanup tasks. There is no need to unregister
     * the profile, because when this method gets called it has already been
     * unregistered.
     *
     * @param {undefined} - No parameters
     * @return {undefined} - void return value
     */
    async Release() {
        debug('Release');

        try {
            // TODO
        } catch (e) {
            logError(e);
        } finally {
            return;
        }
    }

    /**
     * This method gets called when a new service level connection has been
     * made and authorized.
     *
     * @param {string} - DBus object path
     * @param {number} - A number for the incoming connection's file-descriptor
     * @param {object} - An object of properties for the file-descriptor
     * @return {undefined} - void return value
     */
    async NewConnection(object_path, fd, fd_properties) {
        debug(`(${object_path}, ${fd}, ${JSON.stringify(fd_properties)})`);

        let bdevice = this._devices.get(object_path);

        try {
            // Create a Gio.SocketConnection from the file-descriptor
            let socket = Gio.Socket.new_from_fd(fd);
            let connection = socket.connection_factory_create_connection();
            let channel = new Core.Channel(null, 'bluetooth');

            // FIXME: Bluetooth connections are always "incoming" from our
            // perspective so we try checking the IOCondition of the socket to
            // determine direction
            let condition = connection.socket.condition_check(
                GLib.IOCondition.IN | GLib.IOCondition.OUT
            );

            if (condition === GLib.IOCondition.OUT) {
                connection = await channel._sendIdent(connection);
            }

            // Accept the connection
            let success = await channel.accept(connection);

            if (success) {
                bdevice._channel = channel;
                let _id = channel.connect('disconnected', () => {
                    channel.disconnect(_id);
                    bdevice._channel = null;
                });
            } else {
                logWarning(`Bluetooth.ChannelService: failed to connect ${bdevice.Alias}`);
                return;
            }

            channel.identity.body.bluetoothHost = bdevice.Address;
            channel.identity.body.bluetoothPath = bdevice.g_object_path;

            // Bail if the deviceId is missing
            if (!channel.identity.body.hasOwnProperty('deviceId')) {
                channel.close();
                bdevice._channel = null;
                logWarning('missing deviceId', channel.identity.body.deviceName);
                return;
            }

            // Unlike Lan channels, we accept all new connections since they
            // have to be paired over bluetooth anyways
            let device = await this.service._ensureDevice(channel.identity);

            // Attach a device to the channel
            channel.attach(device);
        } catch (e) {
            if (bdevice._channel !== null) {
                bdevice._channel.close();
                bdevice._channel = null;
            }

            logWarning(e, bdevice.Alias);
        } finally {
            return;
        }
    }

    /**
     * This method gets called when a profile gets disconnected.
     *
	 * The file descriptor is no longer owned by the service daemon and the
	 * profile implementation needs to take care of cleaning up all
	 * connections.
	 *
	 * If multiple file descriptors are indicated via NewConnection, it is
	 * expected that all of them are disconnected before returning from this
	 * method call.
	 *
	 * @param {string} object_path - DBus object path
     * @return {undefined} - void return value
     */
    async RequestDisconnection(object_path) {
        debug(object_path);

        try {
            let device = this._devices.get(object_path);

            if (device && device._channel !== null) {
                log(`GSConnect: Disconnecting ${device.Alias}`);
                device._channel.close();
                device._channel = null;
            }
        } catch (e) {
            logError(e);
        } finally {
            return;
        }
    }

    broadcast(object_path=null) {
        try {
            let devices = this._devices;

            if (typeof object_path === 'string') {
                devices = [this._devices.get(object_path)];
            }

            devices.forEach(this._connectDevice);
        } catch (e) {
            logWarning(e, 'Bluetooth.ChannelService');
        }
    }

    destroy() {
        for (let object_path of this._devices.keys()) {
            this.RequestDisconnection(object_path);
        }

        this._profileManager.UnregisterProfile(
            this._profile.get_object_path()
        ).then(result => {
            this._profile.destroy();
        }).catch(logError);
    }
});

