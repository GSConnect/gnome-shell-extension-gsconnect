"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;


var ShellXML = '<node> \
  <interface name="org.freedesktop.DBus.Properties"> \
    <method name="Get"> \
      <arg type="s" name="interface_name" direction="in"/> \
      <arg type="s" name="property_name" direction="in"/> \
      <arg type="v" name="value" direction="out"/> \
    </method> \
    <method name="GetAll"> \
      <arg type="s" name="interface_name" direction="in"/> \
      <arg type="a{sv}" name="properties" direction="out"/> \
    </method> \
    <method name="Set"> \
      <arg type="s" name="interface_name" direction="in"/> \
      <arg type="s" name="property_name" direction="in"/> \
      <arg type="v" name="value" direction="in"/> \
    </method> \
    <signal name="PropertiesChanged"> \
      <arg type="s" name="interface_name"/> \
      <arg type="a{sv}" name="changed_properties"/> \
      <arg type="as" name="invalidated_properties"/> \
    </signal> \
  </interface> \
  <interface name="org.freedesktop.DBus.Introspectable"> \
    <method name="Introspect"> \
      <arg type="s" name="xml_data" direction="out"/> \
    </method> \
  </interface> \
  <interface name="org.freedesktop.DBus.Peer"> \
    <method name="Ping"/> \
    <method name="GetMachineId"> \
      <arg type="s" name="machine_uuid" direction="out"/> \
    </method> \
  </interface> \
  <interface name="org.gnome.Shell"> \
    <method name="Eval"> \
      <arg type="s" name="script" direction="in"> \
      </arg> \
      <arg type="b" name="success" direction="out"> \
      </arg> \
      <arg type="s" name="result" direction="out"> \
      </arg> \
    </method> \
    <method name="FocusSearch"> \
    </method> \
    <method name="ShowOSD"> \
      <arg type="a{sv}" name="params" direction="in"> \
      </arg> \
    </method> \
    <method name="ShowMonitorLabels"> \
      <arg type="a{uv}" name="params" direction="in"> \
      </arg> \
    </method> \
    <method name="ShowMonitorLabels2"> \
      <arg type="a{sv}" name="params" direction="in"> \
      </arg> \
    </method> \
    <method name="HideMonitorLabels"> \
    </method> \
    <method name="FocusApp"> \
      <arg type="s" name="id" direction="in"> \
      </arg> \
    </method> \
    <method name="ShowApplications"> \
    </method> \
    <method name="GrabAccelerator"> \
      <arg type="s" name="accelerator" direction="in"> \
      </arg> \
      <arg type="u" name="flags" direction="in"> \
      </arg> \
      <arg type="u" name="action" direction="out"> \
      </arg> \
    </method> \
    <method name="GrabAccelerators"> \
      <arg type="a(su)" name="accelerators" direction="in"> \
      </arg> \
      <arg type="au" name="actions" direction="out"> \
      </arg> \
    </method> \
    <method name="UngrabAccelerator"> \
      <arg type="u" name="action" direction="in"> \
      </arg> \
      <arg type="b" name="success" direction="out"> \
      </arg> \
    </method> \
    <signal name="AcceleratorActivated"> \
      <arg type="u" name="action"> \
      </arg> \
      <arg type="a{sv}" name="parameters"> \
      </arg> \
    </signal> \
    <property type="s" name="Mode" access="read"> \
    </property> \
    <property type="b" name="OverviewActive" access="readwrite"> \
    </property> \
    <property type="s" name="ShellVersion" access="read"> \
    </property> \
  </interface> \
  <interface name="org.gnome.Shell.Extensions"> \
    <method name="ListExtensions"> \
      <arg type="a{sa{sv}}" name="extensions" direction="out"> \
      </arg> \
    </method> \
    <method name="GetExtensionInfo"> \
      <arg type="s" name="extension" direction="in"> \
      </arg> \
      <arg type="a{sv}" name="info" direction="out"> \
      </arg> \
    </method> \
    <method name="GetExtensionErrors"> \
      <arg type="s" name="extension" direction="in"> \
      </arg> \
      <arg type="as" name="errors" direction="out"> \
      </arg> \
    </method> \
    <method name="InstallRemoteExtension"> \
      <arg type="s" name="uuid" direction="in"> \
      </arg> \
      <arg type="s" name="result" direction="out"> \
      </arg> \
    </method> \
    <method name="UninstallExtension"> \
      <arg type="s" name="uuid" direction="in"> \
      </arg> \
      <arg type="b" name="success" direction="out"> \
      </arg> \
    </method> \
    <method name="LaunchExtensionPrefs"> \
      <arg type="s" name="uuid" direction="in"> \
      </arg> \
    </method> \
    <method name="ReloadExtension"> \
      <arg type="s" name="uuid" direction="in"> \
      </arg> \
    </method> \
    <method name="CheckForUpdates"> \
    </method> \
    <signal name="ExtensionStatusChanged"> \
      <arg type="s" name="uuid"> \
      </arg> \
      <arg type="i" name="state"> \
      </arg> \
      <arg type="s" name="error"> \
      </arg> \
    </signal> \
    <property type="s" name="ShellVersion" access="read"> \
    </property> \
  </interface> \
</node> \
';

var ShellNode = Gio.DBusNodeInfo.new_for_xml(ShellXML);
var ShellIface = ShellNode.lookup_interface("org.gnome.Shell");
var ExtensionsIface = ShellNode.lookup_interface("org.gnome.Shell.Extensions");

var ShellProxy = new Lang.Class({
    Name: "GSConnectShellProxy",
    Extends: DBus.ProxyBase,
    Properties: {
        "OverviewActive": GObject.ParamSpec.boolean(
            "OverviewActive",
            "OverviewActive",
            "Whether the shell is in overview mode",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "Mode": GObject.ParamSpec.string(
            "Mode",
            "ShellMode",
            "Mode the shell is in",
            GObject.ParamFlags.READABLE,
            "user"
        ),
        "ShellVersion": GObject.ParamSpec.boolean(
            "ShellVersion",
            "Gnome Shell Version",
            "Current running version of Gnome Shell",
            GObject.ParamFlags.READABLE,
            "3.26.2"
        )
    },
    Signals: {
        "AcceleratorActivated": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_UINT, GObject.TYPE_VARIANT ]
        }
    },

    _init: function () {
        this.parent({
            g_connection: Gio.DBus.session,
            g_interface_info: ShellIface,
            g_interface_name: ShellIface.name,
            g_name: "org.gnome.Shell",
            g_object_path: "/org/gnome/Shell"
        });

        this._wrapObject();
    }
});


var ExtensionsProxy = new Lang.Class({
    Name: "GSConnectExtensionsProxy",
    Extends: DBus.ProxyBase,
    Properties: {
        "ShellVersion": GObject.ParamSpec.boolean(
            "ShellVersion",
            "Gnome Shell Version",
            "Current running version of Gnome Shell",
            GObject.ParamFlags.READABLE,
            "3.26.2"
        )
    },
    Signals: {
        "ExtensionStatusChanged": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,    // uuid
                GObject.TYPE_UINT,      // state
                GObject.TYPE_STRING     // error
            ]
        }
    },

    _init: function () {
        this.parent({
            g_connection: Gio.DBus.session,
            g_interface_info: ExtensionsIface,
            g_interface_name: ExtensionsIface.name,
            g_name: "org.gnome.Shell",
            g_object_path: "/org/gnome/Shell"
        });

        this._wrapObject();
    }
});

