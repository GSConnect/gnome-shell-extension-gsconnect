"use strict";

// Imports
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


// DBus Constants
var BUS_NAME = "org.kde.kdeconnectd";

const ManagerNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.daemon"> \
    <property name="isDiscoveringDevices" type="b" access="read"/> \
    <signal name="deviceAdded"> \
      <arg name="id" type="s" direction="out"/> \
    </signal> \
    <signal name="deviceRemoved"> \
      <arg name="id" type="s" direction="out"/> \
    </signal> \
    <signal name="deviceVisibilityChanged"> \
      <arg name="id" type="s" direction="out"/> \
      <arg name="isVisible" type="b" direction="out"/> \
    </signal> \
    <signal name="announcedNameChanged"> \
      <arg name="announcedName" type="s" direction="out"/> \
    </signal> \
    <method name="acquireDiscoveryMode"> \
      <arg name="id" type="s" direction="in"/> \
    </method> \
    <method name="releaseDiscoveryMode"> \
      <arg name="id" type="s" direction="in"/> \
    </method> \
    <method name="forceOnNetworkChange"> \
    </method> \
    <method name="announcedName"> \
      <arg type="s" direction="out"/> \
    </method> \
    <method name="setAnnouncedName"> \
      <arg name="name" type="s" direction="in"/> \
    </method> \
    <method name="devices"> \
      <arg type="as" direction="out"/> \
      <arg name="onlyReachable" type="b" direction="in"/> \
      <arg name="onlyPaired" type="b" direction="in"/> \
    </method> \
    <method name="devices"> \
      <arg type="as" direction="out"/> \
      <arg name="onlyReachable" type="b" direction="in"/> \
    </method> \
    <method name="devices"> \
      <arg type="as" direction="out"/> \
    </method> \
    <method name="deviceIdByName"> \
      <arg type="s" direction="out"/> \
      <arg name="name" type="s" direction="in"/> \
    </method> \
  </interface> \
</node> \
');

ManagerNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const DeviceNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.freedesktop.DBus.Properties"> \
    <method name="Get"> \
      <arg name="interface_name" type="s" direction="in"/> \
      <arg name="property_name" type="s" direction="in"/> \
      <arg name="value" type="v" direction="out"/> \
    </method> \
    <method name="Set"> \
      <arg name="interface_name" type="s" direction="in"/> \
      <arg name="property_name" type="s" direction="in"/> \
      <arg name="value" type="v" direction="in"/> \
    </method> \
    <method name="GetAll"> \
      <arg name="interface_name" type="s" direction="in"/> \
      <arg name="values" type="a{sv}" direction="out"/> \
      <annotation name="org.qtproject.QtDBus.QtTypeName.Out0" value="QVariantMap"/> \
    </method> \
    <signal name="PropertiesChanged"> \
      <arg name="interface_name" type="s" direction="out"/> \
      <arg name="changed_properties" type="a{sv}" direction="out"/> \
      <annotation name="org.qtproject.QtDBus.QtTypeName.Out1" value="QVariantMap"/> \
      <arg name="invalidated_properties" type="as" direction="out"/> \
    </signal> \
  </interface> \
  <interface name="org.kde.kdeconnect.device"> \
    <property name="type" type="s" access="read"/> \
    <property name="name" type="s" access="read"/> \
    <property name="iconName" type="s" access="read"/> \
    <property name="statusIconName" type="s" access="read"/> \
    <property name="isReachable" type="b" access="read"/> \
    <property name="isTrusted" type="b" access="read"/> \
    <property name="supportedPlugins" type="as" access="read"/> \
    <signal name="pluginsChanged"> \
    </signal> \
    <signal name="reachableStatusChanged"> \
    </signal> \
    <signal name="trustedChanged"> \
      <arg name="trusted" type="b" direction="out"/> \
    </signal> \
    <signal name="pairingError"> \
      <arg name="error" type="s" direction="out"/> \
    </signal> \
    <signal name="nameChanged"> \
      <arg name="name" type="s" direction="out"/> \
    </signal> \
    <method name="requestPair"> \
    </method> \
    <method name="unpair"> \
    </method> \
    <method name="reloadPlugins"> \
    </method> \
    <method name="encryptionInfo"> \
      <arg type="s" direction="out"/> \
    </method> \
    <method name="isTrusted"> \
      <arg type="b" direction="out"/> \
    </method> \
    <method name="availableLinks"> \
      <arg type="as" direction="out"/> \
    </method> \
    <method name="loadedPlugins"> \
      <arg type="as" direction="out"/> \
    </method> \
    <method name="hasPlugin"> \
      <arg type="b" direction="out"/> \
      <arg name="name" type="s" direction="in"/> \
    </method> \
    <method name="pluginsConfigFile"> \
      <arg type="s" direction="out"/> \
    </method> \
  </interface> \
  <interface name="org.kde.kdeconnect.device.battery"> \
    <signal name="stateChanged"> \
      <arg name="charging" type="b" direction="out"/> \
    </signal> \
    <signal name="chargeChanged"> \
      <arg name="charge" type="i" direction="out"/> \
    </signal> \
    <method name="charge"> \
      <arg type="i" direction="out"/> \
    </method> \
    <method name="isCharging"> \
      <arg type="b" direction="out"/> \
    </method> \
  </interface> \
  <interface name="org.kde.kdeconnect.device.notifications"> \
    <signal name="notificationPosted"> \
      <arg name="publicId" type="s" direction="out"/> \
    </signal> \
    <signal name="notificationRemoved"> \
      <arg name="publicId" type="s" direction="out"/> \
    </signal> \
    <signal name="allNotificationsRemoved"> \
    </signal> \
    <method name="activeNotifications"> \
      <arg type="as" direction="out"/> \
    </method> \
  </interface> \
</node> \
');

DeviceNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const FindMyPhoneNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.findmyphone"> \
    <method name="connected"> \
    </method> \
    <method name="ring"> \
    </method> \
  </interface> \
</node> \
');
FindMyPhoneNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const NotificationNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.notifications.notification"> \
    <method name="dismiss"> \
    </method> \
    <property name="dismissable" type="b" access="read"/> \
    <property name="appName" type="s" access="read"/> \
    <property name="iconPath" type="s" access="read"/> \
    <property name="internalId" type="s" access="read"/> \
    <property name="ticker" type="s" access="read"/> \
  </interface> \
</node> \
');
NotificationNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const PingNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.ping"> \
    <method name="connected"> \
    </method> \
    <method name="sendPing"> \
    </method> \
    <method name="sendPing"> \
      <arg name="customMessage" type="s" direction="in"/> \
    </method> \
  </interface> \
</node> \
');
PingNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const SFTPNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.sftp"> \
    <signal name="mounted"> \
    </signal> \
    <signal name="unmounted"> \
    </signal> \
    <method name="mount"> \
    </method> \
    <method name="unmount"> \
    </method> \
    <method name="mountAndWait"> \
      <arg type="b" direction="out"/> \
    </method> \
    <method name="isMounted"> \
      <arg type="b" direction="out"/> \
    </method> \
    <method name="startBrowsing"> \
      <arg type="b" direction="out"/> \
    </method> \
    <method name="mountPoint"> \
      <arg type="s" direction="out"/> \
    </method> \
    <method name="getDirectories"> \
      <arg type="a{sv}" direction="out"/> \
      <annotation name="org.qtproject.QtDBus.QtTypeName.Out0" value="QVariantMap"/> \
    </method> \
  </interface> \
</node> \
');
SFTPNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const ShareNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.share"> \
    <method name="shareUrl"> \
      <arg name="url" type="s" direction="in"/> \
    </method> \
  </interface> \
</node> \
');
ShareNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

const TelephonyNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.kde.kdeconnect.device.telephony"> \
    <method name="sendSms"> \
      <arg name="phoneNumber" type="s" direction="in"/> \
      <arg name="messageBody" type="s" direction="in"/> \
    </method> \
  </interface> \
</node> \
');
TelephonyNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });

// Start the service backend
function startService() {
    try {
        GLib.spawn_command_line_async("kdeconnect-cli --refresh");
    } catch (e) {
        log("Error spawning KDEConnect daemon: " + e);
    }
}

// Start the backend settings
function startSettings() {
    try {
        GLib.spawn_command_line_async("kcmshell5 kcm_kdeconnect");
    } catch (e) {
        log("Error spawning KDEConnect settings: " + e);
    }
}


var ProxyBase = new Lang.Class({
    Name: "KProxyBase",
    Extends: Gio.DBusProxy,
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_VARIANT ]
        },
        "changed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_VARIANT ]
        }
    },
    
    _init: function (iface, dbusPath) {
        this.parent({
            gConnection: Gio.DBus.session,
            gInterfaceInfo: iface,
            gName: BUS_NAME,
            gObjectPath: dbusPath,
            gInterfaceName: iface.name
        });
        
        this.cancellable = new Gio.Cancellable();
        this.init(null);
    },
    
    // Wrapper functions
    _call: function (name, callback) {
        /* Convert arg_array to a *real* array */
        let args = Array.prototype.slice.call(arguments, 2);
        let methodInfo = this.gInterfaceInfo.lookup_method(name);
        let signature = [];
        let i, ret;
        
        for (i = 0; i < methodInfo.in_args.length; i++) {
            signature.push(methodInfo.in_args[i].signature);
        }
        
        let variant = new GLib.Variant("(" + signature.join("") + ")", args);
        
        if (callback) {
            this.call(name, variant, 0, -1, null, (proxy, result) => {
                let succeeded = false;
                
                try {
                    ret = this.call_finish(result);
                    succeeded = true;
                } catch (e) {
                    log("Error calling " + name + ": " + e.message);
                }
                
                if (succeeded && typeof callback === "function") {
                    return callback(ret);
                }
            });
        } else {
            ret = this.call_sync(name, variant, 0, -1, this.cancellable);
        }
        
        // If return has single arg, only return that
        if (methodInfo.out_args.length === 1) {
            return (ret) ? ret.deep_unpack()[0] : null;
        } else {
            return (ret) ? ret.deep_unpack() : null;
        }
    },
    
    _get: function (name) {
        let value = this.get_cached_property(name);
        return value ? value.deep_unpack() : null;
    },

    _set: function (name, value) {
        let propertyInfo = this.gInterfaceInfo.lookup_property(name);
        let variant = new GLib.Variant(propertyInfo.signature, value);
        
        // Set the cached property first
        this.set_cached_property(name, variant);

        this.call(
            "org.freedesktop.DBus.Properties.Set",
            new GLib.Variant("(ssv)", [this.gInterfaceName, name, variant]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable,
            (proxy, result) => {
                try {
                    this.call_finish(result);
                } catch (e) {
                    log("Error setting " + name + " on " + this.gObjectPath +
                        ": " + e.message
                    );
                }
            }
        );
    },
    
    destroy: function () {
        GObject.signal_handlers_destroy(this);
    }
});


/** A base class for backend Battery implementations */
var Battery = new Lang.Class({
    Name: "KBattery",
    Extends: ProxyBase,
    Properties: {
        "charging": GObject.ParamSpec.boolean(
            "charging",
            "BatteryCharging",
            "Whether the battery is charging or not",
            GObject.ParamFlags.READABLE,
            false
        ),
        "level": GObject.ParamSpec.int(
            "level",
            "BatteryLevel",
            "The battery level",
            GObject.ParamFlags.READABLE,
            0, 100,
            0
        )
    },
    
    _init: function (dbusPath) {
        this.parent(DeviceNode.interfaces[2], dbusPath);
        
        //
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            if (name === "stateChanged") { this.notify("charging"); }
            if (name === "chargeChanged") { this.notify("level"); }
        });
    },
    
    get charging () { return (this._call("isCharging") === true); },
    get level () { return this._call("charge"); }
});


var Notification = new Lang.Class({
    Name: "KNotification",
    Extends: ProxyBase,
    Properties: {
        "content": GObject.ParamSpec.string(
            "content",
            "NotificationContent",
            "The content of the notification",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "dismissable": GObject.ParamSpec.boolean(
            "dismissable",
            "NotificationDismissable",
            "Whether the notification can be dismissed",
            GObject.ParamFlags.READABLE,
            false
        ),
        "icon": GObject.ParamSpec.string(
            "icon",
            "ApplicationIcon",
            "A path to the icon for the application this notification is for",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "id": GObject.ParamSpec.string(
            "id",
            "ApplicationId",
            "The internal Id of the application this notification is for",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "ApplicationName",
            "The name of the application this notification is for",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    
    _init: function (dbusPath) {
        this.parent(NotificationNode.interfaces[0], dbusPath);
    },
    
    get content () { return this._get("ticker"); },
    get dismissable () { return (this._get("dismissable") === true); },
    get icon () { return this._get("iconPath"); },
    get id () { return this._get("internalId"); },
    get name () { return this._get("appName"); },
    
    dismiss: function () {
        this._call("dismiss");
        this.destroy();
    }
});


/** A base class for backend Notification implementations */
var Notifications = new Lang.Class({
    Name: "KNotifications",
    Extends: ProxyBase,
    Properties: {
        // FIXME: need to choose a param type to do this properly
        "notifications": GObject.ParamSpec.string(
            "notifications",
            "ActiveNotifications",
            "A list of Ids of active notifications",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    Signals: {
        "notification": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (dbusPath) {
        this.parent(DeviceNode.interfaces[3], dbusPath);
        
        //
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            if (name === "allNotificationsRemoved") {
                this.notify("notifications");
            } else if (name === "notificationPosted") {
                this.emit("notification::posted", parameters[0]);
                this.notify("notifications");
            } else if (name === "notificationRemoved") {
                this.emit("notification::removed", parameters[0]);
                this.notify("notifications");
            }
        });
    },
    
    // FIXME: need to choose a param type to do this properly
    get notifications () {
        return this._call("activeNotifications");
    }
});


/** A base class for backend Device implementations */
var Device = new Lang.Class({
    Name: "KDevice",
    Extends: ProxyBase,
    Properties: {
        "id": GObject.ParamSpec.string(
            "id",
            "DeviceId",
            "The device Id",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The device name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "reachable": GObject.ParamSpec.boolean(
            "reachable",
            "DeviceReachable",
            "Whether the device is reachable/online",
            GObject.ParamFlags.READABLE,
            false
        ),
        "trusted": GObject.ParamSpec.boolean(
            "trusted",
            "DeviceTrusted",
            "Whether the device is trusted or not",
            GObject.ParamFlags.READABLE,
            false
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "DeviceType",
            "The device type",
            GObject.ParamFlags.READABLE,
            "unknown"
        ),
        "mounted": GObject.ParamSpec.boolean(
            "mounted",
            "DeviceMounted",
            "Whether the device is mounted or not",
            GObject.ParamFlags.READWRITE,
            false
        )
    },
    
    _init: function (manager, dbusPath) {
        this.parent(DeviceNode.interfaces[1], dbusPath);
        
        this._manager = manager;
        
        // Connect to PropertiesChanged
        this.connect("g-properties-changed", (proxy, properties) => {
            properties = properties.deep_unpack();
            
            for (let name in properties) {
                if (name === "name") {
                    this.notify("name");
                } else if (name === "isReachable") {
                    this.notify("reachable");
                } else if (name === "isTrusted") {
                    this.notify("trusted");
                } else if (name === "type") {
                    this.notify("type");
                }
            }
            
            this._reloadPlugins();
        });
        
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            // Cached properties are updated before notifying
            if (name === "nameChanged") {
                this.set_cached_property("name",
                    new GLib.Variant("s", parameters[0])
                );
                this.notify("name");
            } else if (name === "pluginsChanged") {
                this._reloadPlugins();
            } else if (name === "reachableStatusChanged") {
                this.set_cached_property("isReachable",
                    new GLib.Variant("b", !this.reachable)
                );
                this.notify("reachable");
            } else if (name === "trustedChanged") {
                this.set_cached_property("isTrusted",
                    new GLib.Variant("b", !this.trusted)
                );
                this.notify("trusted");
            }
        });
        
        this._reloadPlugins();
        
        Object.defineProperty(this, "mounts", {
            get: () => {
                let dirsObj = this.sftp._call("getDirectories");
                
                for (let dir in dirsObj) {
                    dirsObj[dir] = dirsObj[dir].deep_unpack();
                }
                
                return dirsObj;
            }
        });
    },
    
    // Properties
    get id () { return this.gObjectPath.split("/").pop(); },
    get mounted () { return (this.sftp._call("isMounted") === true); },
    set mounted (bool) {
        if (bool && !this.mounted) {
            this.sftp._call("mountAndWait", true);
        } else if (!bool && this.mounted) {
            this.sftp._call("unmount", true);
        }
    },
    get name () { return this._get("name"); },
    get reachable () { return (this._get("isReachable") === true); },
    get trusted () { return (this._get("isTrusted") === true); },
    get type () { return this._get("type"); },
    
    // Methods
    mount: function () { return this.sftp._call("mountAndWait"); },
    pair: function () { this._call("requestPair", null, true); },
    ping: function () { this.ping._call("sendPing", true); },
    ring: function () { this.findmyphone._call("ring", true); },
    sms: function (number, message) {
        this.telephony._call("sendSms", true, number, message);
    },
    shareURI: function (uri) { this.share._call("shareUrl", true, uri); },
    unpair: function () {
        this._call("unpair", null);
        this._manager._call("forceOnNetworkChange", true);
    },
    
    //
    _reloadPlugins: function () {
        let supported = this._call("loadedPlugins", false);
        
        if (supported.indexOf("kdeconnect_battery") > -1) {
            this.battery = new Battery(this.gObjectPath);
            
            this.battery.connect("notify::level", (battery) => {
                this.emit("changed::battery",
                    new GLib.Variant(
                        "(bi)",
                        [this.battery.charging, this.battery.level]
                    )
                );
            });
            
            // Kickstart the plugin
            this.emit("changed::battery",
                new GLib.Variant(
                    "(bi)",
                    [this.battery.charging, this.battery.level]
                )
            );
        } else if (this.hasOwnProperty("battery")) {
            this.battery.destroy();
            delete this.battery;
        }
        
        if (supported.indexOf("kdeconnect_findmyphone") > -1) {
            this.findmyphone = new ProxyBase(
                FindMyPhoneNode.interfaces[0],
                this.gObjectPath + "/findmyphone"
            );
        } else if (this.hasOwnProperty("findmyphone")) {
            this.findmyphone.destroy();
            delete this.findmyphone;
        }
        
        if (supported.indexOf("kdeconnect_notifications") > -1) {
            this.notifications = new Notifications(this.gObjectPath);
            
            
        } else if (this.hasOwnProperty("notifications")) {
            this.notifications.destroy();
            delete this.notifications;
        }
        
        if (supported.indexOf("kdeconnect_ping") > -1) {
            this.ping = new ProxyBase(
                PingNode.interfaces[0],
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("ping")) {
            this.ping.destroy();
            delete this.ping;
        }
        
        if (supported.indexOf("kdeconnect_sftp") > -1) {
            this.sftp = new ProxyBase(
                SFTPNode.interfaces[0],
                this.gObjectPath + "/sftp"
            );
            
            this.sftp.connect("g-signal", (proxy, sender, name, parameters) => {
                if (name === "mounted" || name === "unmounted") {
                    this.notify("mounted")
                }
            });
        } else if (this.hasOwnProperty("sftp")) {
            this.sftp.destroy();
            delete this.sftp;
        }
        
        if (supported.indexOf("kdeconnect_share") > -1) {
            this.share = new ProxyBase(
                ShareNode.interfaces[0],
                this.gObjectPath + "/share"
            );
        } else if (this.hasOwnProperty("share")) {
            this.share.destroy();
            delete this.share;
        }
        
        if (supported.indexOf("kdeconnect_telephony") > -1) {
            this.telephony = new ProxyBase(
                TelephonyNode.interfaces[0],
                this.gObjectPath + "/telephony"
            );
        } else if (this.hasOwnProperty("telephony")) {
            this.telephony.destroy();
            delete this.telephony;
        }
        
        this.emit("changed::plugins", new GLib.Variant("()", ""));
    },
    
    // Override Methods
    destroy: function () {
        ["battery",
        "findmyphone",
        "notifications",
        "ping",
        "sftp",
        "share",
        "telephony"].forEach((plugin) => {
            if (this.hasOwnProperty(plugin)) {
                this[plugin].destroy();
                delete this[plugin];
            }
        });
        
        ProxyBase.prototype.destroy.call(this);
    }
});


// A DBus Interface wrapper for a device manager
var DeviceManager = new Lang.Class({
    Name: "KDeviceManager",
    Extends: ProxyBase,
    Properties: {
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The host's device name",
            GObject.ParamFlags.READWRITE,
            ""
        ),
        "scanning": GObject.ParamSpec.boolean(
            "scanning",
            "ScanningDevices",
            "Whether scanning for devices is in progress",
            GObject.ParamFlags.READABLE,
            false
        )
    },
    Signals: {
        "device": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function () {
        this.parent(ManagerNode.interfaces[0], "/modules/kdeconnect");
        
        // Track our device proxies, DBus path as key
        this.devices = new Map();
        
        // Track scan request ID's, ensure we don't have an active manager scan
        this._call("releaseDiscoveryMode", true, "manager");
        this._scans = new Map();
        
        // Signals
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            if (name === "announcedNameChanged") {
                let newName = parameters[0];
                this.notify("name");
            } else if (name === "deviceAdded") {
                let dbusPath = "/modules/kdeconnect/devices/" + parameters[0];
                this._deviceAdded(this, dbusPath);
            } else if (name === "deviceRemoved") {
                let dbusPath = "/modules/kdeconnect/devices/" + parameters[0];
                this._deviceRemoved(this, dbusPath);
            } else if (name === "deviceVisibilityChanged") {
                let [id, reachable] = parameters;
                let dbusPath = "/modules/kdeconnect/devices/" + id;
                this.devices.get(dbusPath).notify("reachable");
            }
        });
        
        // Add currently managed devices
        this._call("devices", false).forEach((id) => {
            this._deviceAdded(this, "/modules/kdeconnect/devices/" + id);
        });
    },
    
    get name () { return this._call("announcedName", false); },
    set name (name) { this._call("setAnnouncedName", true, name); },
    get scanning () { return (this._scans.length > 0); },
    
    // Callbacks
    _deviceAdded: function (manager, dbusPath) {
        this.devices.set(dbusPath, new Device(this, dbusPath));
        // Ensure an active scan for this device isn't in progress
        this._call("releaseDiscoveryMode", true, this.devices.get(dbusPath).id);
        this.emit("device::added", dbusPath);
    },
    
    _deviceRemoved: function (manager, dbusPath) {
        this.devices.get(dbusPath).destroy();
        this.devices.delete(dbusPath);
        this.emit("device::removed", dbusPath);
    },
    
    // Public Methods
    scan: function (requestId="manager", timeout=15) {
        if (this._scans.has(requestId)) {
            this._call("releaseDiscoveryMode", false, requestId);
            
            if (this._scans.get(requestId) > 0) {
                GLib.source_remove(this._scans.get(requestId));
            }
            
            this._scans.delete(requestId)
            this.notify("scanning");
            return false;
        } else {
            this._call("acquireDiscoveryMode", false, requestId);
            this._call("forceOnNetworkChange", false);
            
            if (timeout > 0) {
                this._scans.set(
                    requestId,
                    Mainloop.timeout_add_seconds(
                        timeout, 
                        Lang.bind(this, this.scan, requestId),
                        GLib.PRIORITY_DEFAULT
                    )
                );
            } else {
                this._scans.set(requestId, timeout);
            }
            
            this.notify("scanning");
            return true;
        }
    },
    
    destroy: function () {
        for (let dbusPath of this.devices.keys()) {
            this._deviceRemoved(this, dbusPath);
        }
        
        for (let requestId of this._scans.keys()) {
            this.scan(requestId);
        }
        
        ProxyBase.prototype.destroy.call(this);
    }
});

