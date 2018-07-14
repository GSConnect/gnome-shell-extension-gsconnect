'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;
const DBus = imports.modules.dbus;


/**
 * org.bluez Interfaces
 */
var BluezNode = Gio.DBusNodeInfo.new_for_xml(
'<node> \
  <interface name="org.bluez.ProfileManager1"> \
    <method name="RegisterProfile"> \
      <arg name="profile" type="o" direction="in"/> \
      <arg name="UUID" type="s" direction="in"/> \
      <arg name="options" type="a{sv}" direction="in"/> \
    </method> \
    <method name="UnregisterProfile"> \
      <arg name="profile" type="o" direction="in"/> \
    </method> \
  </interface> \
  \
  <!-- Adapter (eg. /org/bluez/hci0) --> \
  <interface name="org.bluez.Adapter1"> \
    <method name="StartDiscovery"/> \
    <method name="SetDiscoveryFilter"> \
      <arg name="properties" type="a{sv}" direction="in"/> \
    </method> \
    <method name="StopDiscovery"/> \
    <method name="RemoveDevice"> \
      <arg name="device" type="o" direction="in"/> \
    </method> \
    <property name="Address" type="s" access="read"/> \
    <property name="Name" type="s" access="read"/> \
    <property name="Alias" type="s" access="readwrite"/> \
    <property name="Class" type="u" access="read"/> \
    <property name="Powered" type="b" access="readwrite"/> \
    <property name="Discoverable" type="b" access="readwrite"/> \
    <property name="DiscoverableTimeout" type="u" access="readwrite"/> \
    <property name="Pairable" type="b" access="readwrite"/> \
    <property name="PairableTimeout" type="u" access="readwrite"/> \
    <property name="Discovering" type="b" access="read"/> \
    <property name="UUIDs" type="as" access="read"/> \
    <property name="Modalias" type="s" access="read"/> \
  </interface> \
  \
  <!-- Device (eg. /org/bluez/hci0/dev_00_00_00_00_00_00) --> \
  <interface name="org.bluez.Device1"> \
    <!-- Methods --> \
    <method name="Disconnect"/> \
    <method name="Connect"/> \
    <method name="ConnectProfile"> \
      <arg name="UUID" type="s" direction="in"/> \
    </method> \
    <method name="DisconnectProfile"> \
      <arg name="UUID" type="s" direction="in"/> \
    </method> \
    <method name="Pair"/> \
    <method name="CancelPairing"/> \
    <!-- Properties --> \
    <property name="Address" type="s" access="read"/> \
    <property name="AddressType" type="s" access="read"/> \
    <property name="Name" type="s" access="read"/> \
    <property name="Alias" type="s" access="readwrite"/> \
    <property name="Class" type="u" access="read"/> \
    <property name="Appearance" type="q" access="read"/> \
    <property name="Icon" type="s" access="read"/> \
    <property name="Paired" type="b" access="read"/> \
    <property name="Trusted" type="b" access="readwrite"/> \
    <property name="Blocked" type="b" access="readwrite"/> \
    <property name="LegacyPairing" type="b" access="read"/> \
    <property name="RSSI" type="n" access="read"/> \
    <property name="Connected" type="b" access="read"/> \
    <property name="UUIDs" type="as" access="read"/> \
    <property name="Modalias" type="s" access="read"/> \
    <property name="Adapter" type="o" access="read"/> \
    <property name="ManufacturerData" type="a{qv}" access="read"/> \
    <property name="ServiceData" type="a{sv}" access="read"/> \
    <property name="TxPower" type="n" access="read"/> \
    <property name="ServicesResolved" type="b" access="read"/> \
  </interface> \
  \
  <!-- Profile (to be exported) --> \
  <interface name="org.bluez.Profile1"> \
    <!-- Methods --> \
    <method name="Release"/> \
    <method name="NewConnection"> \
      <arg name="device" type="o" direction="in"/> \
      <arg name="fd" type="h" direction="in"/> \
      <arg name="fd_properties" type="a{sv}" direction="in"/> \
    </method> \
    <method name="RequestDisconnection"> \
      <arg name="object_path" type="o" direction="in"/> \
    </method> \
  </interface> \
</node>'
);


/**
 * Proxy for org.bluez.Adapter1 interface
 */
var ProfileManager1Proxy = DBus.makeInterfaceProxy(
    BluezNode.lookup_interface('org.bluez.ProfileManager1')
);

var Adapter1Proxy = DBus.makeInterfaceProxy(
    BluezNode.lookup_interface('org.bluez.Adapter1')
);

var Device1Proxy = DBus.makeInterfaceProxy(
    BluezNode.lookup_interface('org.bluez.Device1')
);


/**
 * KDE Connect Service UUID
 */
var SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';


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
 * Bluez Channel Service
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Properties: {
        'discovering': GObject.ParamSpec.boolean(
            'discovering',
            'ServiceDiscovering',
            'Whether the Bluetooth Listener is active',
            GObject.ParamFlags.READWRITE,
            true
        )
    }
}, class ChannelService extends GObject.Object {
    _init() {
        super._init();

        this.service = Gio.Application.get_default();

        //
        this.devices = new Map();

        // Export the org.bluez.Profile1 interface for the KDE Connect service
        this._profile = new DBus.Interface({
            g_connection: Gio.DBus.system,
            g_instance: this,
            g_interface_info: BluezNode.lookup_interface('org.bluez.Profile1'),
            g_object_path: gsconnect.app_path
        });

        // Setup profile
        new ProfileManager1Proxy({
            g_connection: Gio.DBus.system,
            g_name: 'org.bluez',
            g_object_path: '/org/bluez'
        }).init_promise().then(profileManager => {
            this._profileManager = profileManager;
            return this._registerProfile(SERVICE_UUID);
        }).then(result => {
            Gio.DBusObjectManagerClient.new(
                Gio.DBus.system,
                Gio.DBusObjectManagerClientFlags.NONE,
                'org.bluez',
                '/',
                null,
                null,
                this._setupObjManager.bind(this)
            );
        }).catch(debug);
    }

    _registerProfile(uuid) {
        let profileOptions = {
            // Don't require confirmation
            RequireAuthorization: new GLib.Variant('b', false),
            // Only allow paired devices
            RequireAuthentication: new GLib.Variant('b', true),
            // Service Record (customized to work with Android)
            ServiceRecord: new GLib.Variant('s', makeSdpRecord(uuid))
        };

        // Register KDE Connect bluez profile
        return this._profileManager.RegisterProfile(
            this._profile.get_object_path(),
            uuid,
            profileOptions
        );
    }

    _onInterfaceAdded(manager, object, iface) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            debug(`Device on ${iface.g_object_path}`);

            new Device1Proxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.bluez',
                g_object_path: iface.g_object_path
            }).init_promise().then(device => {
                if (!this.devices.has(device.g_object_path)) {
                    debug('adding device');

                    this.devices.set(device.g_object_path, device);
                    this._onDeviceChanged(device);
                }
            }).catch(debug);
        }
    }

    _onInterfaceRemoved(manager, object, iface) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            this.devices.delete(iface.g_object_path);
        }
    }

    _onPropertiesChanged(manager, object, iface, changed, invalidated) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            let properties = gsconnect.full_unpack(changed);
            let device = this.devices.get(iface.g_object_path);

            if (properties.hasOwnProperty('Connected')) {
                if (device.Connected) {
                    log('Connected changed');
                    this._onDeviceChanged(device);
                } else {
                    this.RequestDisconnection(iface.g_object_path);
                }
            } else if (properties.hasOwnProperty('ServicesResolved') &&
                       properties.ServicesResolved) {
                    log('ServicesResolved changed');
                    this._onDeviceChanged(device);
            }
        }
    }

    _onDeviceChanged(device) {
        if (device._channel !== undefined) {
            return;
        }

        if (device.Connected && device.Paired && device.UUIDs.indexOf(SERVICE_UUID) > -1) {
            debug('Trying to connect profile...');
            device.ConnectProfile(SERVICE_UUID).then(result=> {

                debug(`Profile connected for to ${device.Name}`);
            }).catch(e => debug(e.message));
        }
    }

    _setupObjManager(obj, res) {
        this._objManager = Gio.DBusObjectManagerClient.new_finish(res);

        for (let obj of this._objManager.get_objects()) {
            for (let iface of obj.get_interfaces()) {
                this._onInterfaceAdded(this._objManager, obj, iface);
            }
        }

        this._objManager._interfaceAddedId = this._objManager.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );
        this._objManager._interfaceRemovedId = this._objManager.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );
        this._objManager._interfacePropertiesId = this._objManager.connect(
            'interface-proxy-properties-changed',
            this._onPropertiesChanged.bind(this)
        );
    }

    /**
     * This method gets called when the service daemon unregisters the profile.
     * A profile can use it to do cleanup tasks. There is no need to unregister
     * the profile, because when this method gets called it has already been
     * unregistered.
     */
    Release() {
        debug(arguments);
    }

    /**
     * This method gets called when a new service level connection has been
     * made and authorized.
     */
    NewConnection(object_path, fd, fd_properties) {
        debug(`(${object_path}, ${fd}, ${JSON.stringify(fd_properties)})`);

        let device = this.devices.get(object_path);

        device._channel = new Core.Channel();
        let _connectedId = device._channel.connect('connected', (channel) => {
            channel.disconnect(_connectedId);
            channel.disconnect(_disconnectedId);

            channel.identity.body.bluetoothHost = device.Address;
            channel.identity.body.bluetoothPath = device.g_object_path;

            this.service._addDevice(channel.identity, channel);
        });

        let _disconnectedId = device._channel.connect('disconnected', (channel) => {
            channel.disconnect(_connectedId);
            channel.disconnect(_disconnectedId);
        });

        // Create a Gio.SocketConnection from the file-descriptor
        let socket = Gio.Socket.new_from_fd(fd);
        let connection = socket.connection_factory_create_connection();

        // NewConnection() is actually called in response to ConnectProfile()
        // so maybe it makes more sense for this to use open() somehow?
        device._channel._sendIdent(connection).then(connection => {
            return device._channel.accept(connection);
        });
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
     */
    RequestDisconnection(object_path) {
        debug(object_path);

        let device = this.devices.get(object_path);

        if (device && device._channel !== undefined) {
            log(`GSConnect: Disconnecting ${device.Name}`);
            device._channel.close();
            device._channel = undefined;
        }
    }

    destroy() {
        this._objManager.disconnect(this._objManager._interfaceAddedId);
        this._objManager.disconnect(this._objManager._interfaceRemovedId);
        this._objManager.disconnect(this._objManager._interfacePropertiesId);

        for (let object_path of this.devices.keys()) {
            this.RequestDisconnection(object_path);
        }

        this._profileManager.UnregisterProfile(
            this._profile.get_object_path()
        ).then(result => {
            this._profile.destroy();
            debug('Successfully unregistered bluez profile');
        }).catch(debug);
    }
});

