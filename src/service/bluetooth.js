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
  <!-- Manager (eg. /org/bluez) --> \
  <interface name="org.bluez.AgentManager1"> \
    <method name="RegisterAgent">\
      <arg name="agent" type="o" direction="in"/> \
      <arg name="capability" type="s" direction="in"/> \
    </method> \
    <method name="UnregisterAgent"> \
      <arg name="agent" type="o" direction="in"/> \
    </method> \
    <method name="RequestDefaultAgent"> \
      <arg name="agent" type="o" direction="in"/> \
    </method> \
  </interface> \
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
  <!-- Profile (to be exported --> \
  <interface name="org.bluez.Profile1"> \
    <!-- Methods --> \
    <method name="Release"/> \
    <method name="NewConnection"> \
      <arg name="object_path" type="o" direction="in"/> \
      <arg name="socket" type="h" direction="in"/> \
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
    BluezNode.lookup_interface("org.bluez.ProfileManager1")
);

var Adapter1Proxy = DBus.makeInterfaceProxy(
    BluezNode.lookup_interface("org.bluez.Adapter1")
);

var Device1Proxy = DBus.makeInterfaceProxy(
    BluezNode.lookup_interface("org.bluez.Device1")
);

var Profile1Iface = BluezNode.lookup_interface("org.bluez.Profile1");


/**
 * Service Discovery Protocol Record (KDE Connect)
 */
const SdpRecordTemplate = '<?xml version="1.0" encoding="utf-8" ?> \
<record> \
  <attribute id="0x0001"> \
    <!-- ServiceClassIDList --> \
    <sequence> \
      <uuid value="%s" />    <!-- Custom UUID --> \
      <uuid value="0x%s" />  <!-- Custom UUID hex for Android --> \
      <uuid value="0x1101" />  <!-- SPP profile --> \
    </sequence> \
  </attribute> \
  <attribute id="0x0003"> \
    <!-- ServiceID --> \
    <uuid value="%s" /> \
  </attribute> \
  <attribute id="0x0004"> \
    <!-- ProtocolDescriptorList --> \
    <sequence> \
      <sequence> \
      <uuid value="0x0100" /> \
      %s \
      </sequence> \
      <sequence> \
      <uuid value="0x0003" /> \
      %s \
      </sequence> \
    </sequence> \
  </attribute> \
  <attribute id="0x0005"> \
    <!-- BrowseGroupList --> \
    <sequence> \
      <uuid value="0x1002" /> \
    </sequence> \
  </attribute> \
  <attribute id="0x0009"> \
    <!-- ProfileDescriptorList --> \
    <sequence> \
      <uuid value="0x1101" /> \
    </sequence> \
  </attribute> \
  <attribute id="0x0100"> \
    <!-- Service name --> \
    <text value="%s" /> \
  </attribute> \
</record>';

// OMG I'm a terrible person
Number.prototype.phx = function(len) {
    let str = this.toString(16);
    return '0x' + '0'.repeat(len - str.length) + str;
};


function get_sdp_record(name, uuid, channel, psm) {
    let channel_str = (channel) ? '<uint8 value="%s" />'.format(channel.phx(4)) : '';
    let psm_str = (psm) ? '<uint8 value="%s" />'.format(psm.phx(4)) : '';

    return SdpRecordTemplate.format(
        uuid,                   // Custom UUID
        uuid.replace('-', ''),  // Custom Android UUID
        uuid,                   // Service UUID
        channel_str,            // RFCOMM channel
        psm_str,                // RFCOMM channel
        name                    // ???
    );
};


/**
 * Bluez Device Channel
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
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
        )
    }
}, class Channel extends GObject.Object {
    _init() {
        super._init();
    }
});


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

        this._kdeUUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
        this._sppUUID = '00001101-0000-1000-8000-00805f9b34fb';

        this._dbus = new DBus.ProxyServer({
            g_connection: Gio.DBus.session,
            g_instance: this,
            g_interface_info: Profile1Iface,
            g_object_path: gsconnect.app_path
        });

        Gio.DBusObjectManagerClient.new(
            Gio.DBus.system,
            Gio.DBusObjectManagerClientFlags.NONE,
            'org.bluez',
            '/',
            null,
            null,
            this._setupObjManager.bind(this)
        );
    }

    _getProfile() {
        let channel = null;
        let psm = null;

        let sdpRecord = get_sdp_record(
            'GSConnectBT',
            this._sppUUID,
            channel,
            psm
        );

        let profile = {
            Name: new GLib.Variant('s', 'GSConnectBT'),
            //Service: new GLib.Variant('s', 'spp char BLUETOOTH_KDE_UUID'),
            RequireAuthentication: new GLib.Variant('b', true),
            RequireAuthorization: new GLib.Variant('b', false),
            AutoConnect: new GLib.Variant('b', true),
            ServiceRecord: new GLib.Variant('s', sdpRecord)
        };

        if (channel) {
            profile.Channel = new GLib.Variant('q', channel);
        }

        if (psm) {
            profile.PSM = new GLib.Variant('q', psm);
        }

        return profile;
    }

    _registerProfile() {
        let profile = this._getProfile();

        log('ABOUT TO REGISTER PROFILE');

        return this._profileManager.RegisterProfile(
            this._dbus.get_object_path(),
            this._kdeUUID,
            profile
        );
    }

    _setupObjManager(obj, res) {
        this._objManager = Gio.DBusObjectManagerClient.new_finish(res);

        // Connect to ProfileManager1
        this._profileManager = new ProfileManager1Proxy({
            g_connection: Gio.DBus.system,
            g_name: 'org.bluez',
            g_object_path: '/org/bluez'
        });
        this._profileManager.init_promise().then(result => {
            log('Profile Manager Connected');
            return this._registerProfile();
        }).catch(debug);

        // Setup currently managed objects
        for (let obj of this._objManager.get_objects()) {
            for (let iface of obj.get_interfaces()) {
                this._interfaceAdded(this._objManager, obj, iface);
            }
        }

        // Watch for new and removed
        this._objManager.connect('interface-added', this._interfaceAdded.bind(this));
        this._objManager.connect('interface-removed', this._interfaceRemoved.bind(this));
    }

    _interfaceAdded(manager, object, iface) {
        // We aren't interested in object paths
        if (!iface instanceof Gio.DBusProxy) {
            return;
        }

        // A device
        if (iface.g_interface_name === 'org.bluez.Device1') {
            debug('Device on ' + iface.g_object_path);

            let device = new Device1Proxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.bluez',
                g_object_path: iface.g_object_path
            });
            device.init(null);

        // An adapter
        } else if (iface.g_interface_name === 'org.bluez.Adapter1') {
            debug('Adapter on ' + iface.g_object_path);

            this._adapter = new Adapter1Proxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.bluez',
                g_object_path: iface.g_object_path
            });
            this._adapter.init_promise().then(result => {
                log('Address: ' + this._adapter.Address);
            }).catch(debug);
        }

        //debug(iface.g_object_path + ':' + iface.g_interface_name);
    }

    _interfaceRemoved(manager, object, iface) {
        debug(iface.g_interface_name);
    }

    // DBus Methods
    // https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/doc/profile-api.txt
    Release() {
        debug(arguments);
    }

    NewConnection() {
        debug(arguments);
    }

    RequestDisconnection() {
        debug(arguments);
    }
});

