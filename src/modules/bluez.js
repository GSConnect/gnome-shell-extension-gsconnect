"use strict";

const Lang = imports.lang;

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
  \
  <!-- Adapter (eg. /org/bluez/hci0) --> \
  <interface name="org.bluez.Adapter1"> \
    <method name="StartDiscovery"></method> \
    <method name="SetDiscoveryFilter"> \
      <arg name="properties" type="a{sv}" direction="in"/> \
    </method> \
    <method name="StopDiscovery"></method> \
    <method name="RemoveDevice"> \
      <arg name="device" type="o" direction="in"/> \
    </method> \
    <property name="Address" type="s" access="read"></property> \
    <property name="Name" type="s" access="read"></property> \
    <property name="Alias" type="s" access="readwrite"></property> \
    <property name="Class" type="u" access="read"></property> \
    <property name="Powered" type="b" access="readwrite"></property> \
    <property name="Discoverable" type="b" access="readwrite"></property> \
    <property name="DiscoverableTimeout" type="u" access="readwrite"></property> \
    <property name="Pairable" type="b" access="readwrite"></property> \
    <property name="PairableTimeout" type="u" access="readwrite"></property> \
    <property name="Discovering" type="b" access="read"></property> \
    <property name="UUIDs" type="as" access="read"></property> \
    <property name="Modalias" type="s" access="read"></property> \
  </interface> \
  <interface name="org.bluez.GattManager1"> \
    <method name="RegisterApplication"> \
      <arg name="application" type="o" direction="in"/> \
      <arg name="options" type="a{sv}" direction="in"/> \
    </method> \
    <method name="UnregisterApplication"> \
      <arg name="application" type="o" direction="in"/> \
    </method> \
  </interface> \
  <interface name="org.bluez.Media1"> \
    <method name="RegisterEndpoint"> \
      <arg name="endpoint" type="o" direction="in"/> \
      <arg name="properties" type="a{sv}" direction="in"/> \
    </method> \
    <method name="UnregisterEndpoint"> \
      <arg name="endpoint" type="o" direction="in"/> \
    </method> \
    <method name="RegisterPlayer"> \
      <arg name="player" type="o" direction="in"/> \
      <arg name="properties" type="a{sv}" direction="in"/> \
    </method> \
    <method name="UnregisterPlayer"> \
      <arg name="player" type="o" direction="in"/> \
    </method> \
  </interface> \
  <interface name="org.bluez.NetworkServer1"> \
    <method name="Register"> \
      <arg name="uuid" type="s" direction="in"/> \
      <arg name="bridge" type="s" direction="in"/> \
    </method> \
    <method name="Unregister"> \
      <arg name="uuid" type="s" direction="in"/> \
    </method> \
  </interface> \
  \
  \
  <!-- Device (eg. /org/bluez/hci0/dev_00_00_00_00_00_00) --> \
  <interface name="org.bluez.Device1"> \
    <!-- Methods --> \
    <method name="Disconnect"></method> \
    <method name="Connect"></method> \
    <method name="ConnectProfile"> \
      <arg name="UUID" type="s" direction="in"/> \
    </method> \
    <method name="DisconnectProfile"> \
      <arg name="UUID" type="s" direction="in"/> \
    </method> \
    <method name="Pair"></method> \
    <method name="CancelPairing"></method> \
    <!-- Properties --> \
    <property name="Address" type="s" access="read"></property> \
    <property name="Name" type="s" access="read"></property> \
    <property name="Alias" type="s" access="readwrite"></property> \
    <property name="Class" type="u" access="read"></property> \
    <property name="Appearance" type="q" access="read"></property> \
    <property name="Icon" type="s" access="read"></property> \
    <property name="Paired" type="b" access="read"></property> \
    <property name="Trusted" type="b" access="readwrite"></property> \
    <property name="Blocked" type="b" access="readwrite"></property> \
    <property name="LegacyPairing" type="b" access="read"></property> \
    <property name="RSSI" type="n" access="read"></property> \
    <property name="Connected" type="b" access="read"></property> \
    <property name="UUIDs" type="as" access="read"></property> \
    <property name="Modalias" type="s" access="read"></property> \
    <property name="Adapter" type="o" access="read"></property> \
    <property name="ManufacturerData" type="a{qv}" access="read"></property> \
    <property name="ServiceData" type="a{sv}" access="read"></property> \
    <property name="TxPower" type="n" access="read"></property> \
    <property name="ServicesResolved" type="b" access="read"></property> \
  </interface> \
  <interface name="org.bluez.Network1"> \
    <!-- Methods --> \
    <method name="Connect"><arg name="uuid" type="s" direction="in"/> \
      <arg name="interface" type="s" direction="out"/> \
    </method> \
    <method name="Disconnect"></method> \
    <!-- Properties --> \
    <property name="Connected" type="b" access="read"></property> \
    <property name="Interface" type="s" access="read"></property> \
    <property name="UUID" type="s" access="read"></property> \
  </interface> \
  <interface name="org.bluez.MediaControl1"> \
    <!-- Methods --> \
    <method name="Play"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="Pause"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="Stop"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="Next"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="Previous"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="VolumeUp"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="VolumeDown"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="FastForward"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <method name="Rewind"> \
      <annotation name="org.freedesktop.DBus.Deprecated" value="true"/> \
    </method> \
    <!-- Properties --> \
    <property name="Connected" type="b" access="read"></property> \
    <property name="Player" type="o" access="read"></property> \
  </interface> \
  <node name="fd0"/> \
  <node name="player0"/> \
</node>'
);

const AgentManager1Iface = BluezNode.lookup_interface("org.bluez.AgentManager1");
const ProfileManager1Iface = BluezNode.lookup_interface("org.bluez.ProfileManager1");

const Adapter1Iface = BluezNode.lookup_interface("org.bluez.Adapter1");
const GattManager1Iface = BluezNode.lookup_interface("org.bluez.GattManager1");
const Media1Iface = BluezNode.lookup_interface("org.bluez.Media1");
const NetworkServer1Iface = BluezNode.lookup_interface("org.bluez.NetworkServer1");

const DeviceIface = BluezNode.lookup_interface("org.bluez.Device1"); // properties
const MediaControl1Iface = BluezNode.lookup_interface("org.bluez.MediaControl1"); //properties
const Network1Iface = BluezNode.lookup_interface("org.bluez.Network1"); //properties



/**
 * Implementing a singleton
 */
var _default;

function get_default() {
    if (!_default) {
        _default = new FdoProxy(); // FIXME
    }

    return _default;
};


/**
 * Proxy for org.bluez.Adapter1 interface
 */
var Adapter1Proxy = new Lang.Class({
    Name: "GSConnectAdapter1Proxy",
    Extends: DBus.ProxyBase,
    Properties: {
        "UUIDs": GObject.param_spec_variant(
            "UUIDs",
            "AdapterUUIDs",
            "...",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "Discoverable": GObject.ParamSpec.boolean(
            "Discoverable",
            "AdapterDiscovering",
            "...",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "Discovering": GObject.ParamSpec.boolean(
            "Discovering",
            "AdapterDiscovering",
            "...",
            GObject.ParamFlags.READABLE,
            false
        ),
        "Pairable": GObject.ParamSpec.boolean(
            "Pairable",
            "AdapterPairable",
            "...",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "Powered": GObject.ParamSpec.boolean(
            "Powered",
            "AdapterPowered",
            "...",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "Address": GObject.ParamSpec.string(
            "Address",
            "AdapterAddress",
            "...",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "Alias": GObject.ParamSpec.string(
            "Alias",
            "AdapterAlias",
            "Visible Name (eg. hostname)",
            GObject.ParamFlags.READWRITE,
            ""
        ),
        "Modalias": GObject.ParamSpec.string(
            "Modalias",
            "AdapterModalias",
            "...",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "Name": GObject.ParamSpec.string(
            "Name",
            "AdapterName",
            "...",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "Class": GObject.ParamSpec.uint(
            "Class",
            "AdapterClass",
            "...",
            GObject.ParamFlags.READABLE,
            new GLib.Variant("u", 0), new GLib.Variant("u", GLib.MAXUINT32),
            new GLib.Variant("u", 0)
        ),
        "DiscoverableTimeout": GObject.ParamSpec.uint(
            "DiscoverableTimeout",
            "AdapterDiscoverableTimeout",
            "...",
            GObject.ParamFlags.READWRITE,
            new GLib.Variant("u", 0), new GLib.Variant("u", GLib.MAXUINT32),
            new GLib.Variant("u", 0)
        ),
        "PairableTimeout": GObject.ParamSpec.uint(
            "PairableTimeout",
            "AdapterPairableTimeout",
            "...",
            GObject.ParamFlags.READWRITE,
            new GLib.Variant("u", 0), new GLib.Variant("u", GLib.MAXUINT32),
            new GLib.Variant("u", 0)
        )
    },

    _init: function (params) {
        params = Object.assign({
            g_connection: Gio.DBus.system,
            g_interface_info: Adapter1Iface,
            g_interface_name: Adapter1Iface.name,
            g_name: "org.bluez",
            g_object_path: "/org/bluez/hci0"
        }, params);

        this.parent(params);
    }
});

