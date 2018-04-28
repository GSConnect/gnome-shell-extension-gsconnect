'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
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
 * Service Discovery Protocol Record (KDE Connect)
 */
const KDE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';

const SdpRecord = Gio.resources_lookup_data(
    gsconnect.app_path + '/' + gsconnect.app_id + '.sdp.xml',
    Gio.ResourceLookupFlags.NONE
).toArray().toString();


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
    },
    Signals: {
        'channel': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        },
        'packet': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class ChannelService extends GObject.Object {
    _init() {
        super._init();

        this.service = Gio.Application.get_default();

        //
        this._devices = new Map();

        // The exported Profile1 interface
        debug('Atempting to export Profile1');
        this._dbus = new DBus.ProxyServer({
            g_connection: Gio.DBus.system,
            g_instance: this,
            g_interface_info: BluezNode.lookup_interface('org.bluez.Profile1'),
            g_object_path: gsconnect.app_path
        });

        // Setup profile
        this._profileManager = new ProfileManager1Proxy({
            g_connection: Gio.DBus.system,
            g_name: 'org.bluez',
            g_object_path: '/org/bluez'
        });
        this._profileManager.init(null);

        let profile = {
            Name: new GLib.Variant('s', 'GSConnectBT'),
            //Service: new GLib.Variant('s', KDE_UUID),
            RequireAuthentication: new GLib.Variant('b', true),
            RequireAuthorization: new GLib.Variant('b', false),
            AutoConnect: new GLib.Variant('b', true),
            ServiceRecord: new GLib.Variant('s', SdpRecord)
        };

        this._profileManager.RegisterProfile(
            this._dbus.get_object_path(),
            KDE_UUID,
            profile
        ).then(result => {
            log('GSConnect: Bluez profile registered');

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

    _onInterfaceAdded(manager, object, iface) {
        // We aren't interested in object paths
        if (!iface instanceof Gio.DBusProxy) {
            return;
        }

        // A device
        if (iface.g_interface_name === 'org.bluez.Device1') {
            debug('Device on ' + iface.g_object_path);

            new Device1Proxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.bluez',
                g_object_path: iface.g_object_path
            }).init_promise().then(device => {
                if (device.Paired && device.Connected &&
                    device.UUIDs.indexOf(KDE_UUID) > -1 &&
                    !this._devices.has(device.g_object_path)) {

                    debug('Trying to connect new device...');
                    device.ConnectProfile(KDE_UUID).then(result => {
                        debug('Connected?');
                        this._devices.set(device.g_object_path, device);
                    }).catch(debug);
                }
            }).catch(debug);

        // TODO: presumably this is only used for discovery
        } else if (iface.g_interface_name === 'org.bluez.Adapter1') {
            debug(`Adapter on ${iface.g_object_path}`);

//            this._adapter = new Adapter1Proxy({
//                g_connection: Gio.DBus.system,
//                g_name: 'org.bluez',
//                g_object_path: iface.g_object_path
//            });
//            this._adapter.init_promise().then(adapter => {
//                log(`Adapter Address: ${this._adapter.Address}`);
//            }).catch(debug);
        }
    }

    _onInterfaceRemoved(manager, object, iface) {
        // We aren't interested in object paths
        if (!iface instanceof Gio.DBusProxy) {
            return;
        }

        debug(iface.g_interface_name);

        if (iface.g_interface_name === 'org.bluez.Device1') {
            if (this._devices.has(iface.g_object_path)) {
                log(`GSConnect Bluetooth: Removing ${iface.get_cached_property('Name').unpack()}`);
                this._devices.delete(iface.g_object_path);
            }
        }
    }

    _onPropertiesChanged(manager, object, iface, properties, invalidated) {
        if (iface.g_interface_name === 'org.bluez.Device1') {
            properties = gsconnect.full_unpack(properties);

            if (properties.hasOwnProperty('Connected') && !properties.Connected) {
                this.RequestDisconnection(iface.g_object_path);
            } else if (properties.Connected) {
                this._onDeviceConnected(iface);
            }
        }
    }

    _onDeviceConnected(iface) {
        if (this._devices.has(iface.g_object_path)) {
            let device = this._devices.get(iface.g_object_path);

            if (device.Connected && device.Paired && device.UUIDs.indexOf(KDE_UUID) > -1) {
                debug('Trying to connect profile...');
//                device.ConnectProfile(KDE_UUID).then(result=> {
//                    debug('Connected?');
//                }).catch(debug);
            }
            //
        } else {
            this._onInterfaceAdded(null, null, iface);
        }
    }

    _setupObjManager(obj, res) {
        this._objManager = Gio.DBusObjectManagerClient.new_finish(res);
        this._objManager.connect(
            'interface-added',
            this._onInterfaceAdded.bind(this)
        );
        this._objManager.connect(
            'interface-removed',
            this._onInterfaceRemoved.bind(this)
        );
        this._objManager.connect(
            'interface-proxy-properties-changed',
            this._onPropertiesChanged.bind(this)
        );

        this._addDevices();
    }

    _addDevices() {
        for (let obj of this._objManager.get_objects()) {
            for (let iface of obj.get_interfaces()) {
                this._onInterfaceAdded(this._objManager, obj, iface);
            }
        }
    }

    // DBus Methods
    // https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/doc/profile-api.txt
    Release() {
        debug(arguments);
    }

    NewConnection(object_path, fd, fd_properties) {
        debug(`(${object_path}, ${fd}, ${JSON.stringify(fd_properties)})`);

        let socket = new Gio.Socket({ fd: fd });
        socket.init(null);
        log(socket);

        socket.send(this.service.identity.toString(), null);
    }

    RequestDisconnection(object_path) {
        debug(object_path);

        // TODO: other stuff?
        let device = this._devices.get(object_path);

        if (device) {
            log(`GSConnect Bluetooth: Removing ${device.Name}`);
            this._devices.delete(device.g_object_path);

            // TODO: Auto disconnect?
            //device.DisconnectProfile(KDE_UUID).then(result => {
            //    this._devices.delete(device.g_object_path);
            //});
        }
    }

    // TODO: this probably needs a lot of work and testing
    destroy() {
        GObject.signal_handlers_destroy(this._objManager);

        for (let object_path of this._devices.keys()) {
            this.RequestDisconnection(object_path);
        }

        this._profileManager.UnregisterProfile(KDE_UUID).then(result => {
            debug('Successfully unregistered bluez profile');
        }).catch(debug);
    }
});

