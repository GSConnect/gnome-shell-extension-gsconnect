"use strict";

// Imports
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


// DBus Constants
var BUS_NAME = "org.mconnect";

const DeviceNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
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
  <interface name="org.mconnect.Device"> \
    <property type="s" name="Id" access="readwrite"/> \
    <property type="s" name="Name" access="readwrite"/> \
    <property type="s" name="DeviceType" access="readwrite"/> \
    <property type="u" name="ProtocolVersion" access="readwrite"/> \
    <property type="s" name="Address" access="readwrite"/> \
    <property type="b" name="IsPaired" access="readwrite"/> \
    <property type="b" name="Allowed" access="readwrite"/> \
    <property type="b" name="IsActive" access="readwrite"/> \
    <property type="b" name="IsConnected" access="readwrite"/> \
    <property type="as" name="IncomingCapabilities" access="readwrite"/> \
    <property type="as" name="OutgoingCapabilities" access="readwrite"/> \
  </interface> \
  <interface name="org.mconnect.Device.Battery"> \
    <property type="u" name="Level" access="readwrite"/> \
    <property type="b" name="Charging" access="readwrite"/> \
  </interface> \
  <interface name="org.mconnect.Device.Ping"> \
    <signal name="Ping"> \
    </signal> \
  </interface> \
</node> \
');

DeviceNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });


const ManagerNode = new Gio.DBusNodeInfo.new_for_xml('\
<node> \
  <interface name="org.mconnect.DeviceManager"> \
    <method name="AllowDevice"> \
      <arg type="s" name="path" direction="in"/> \
    </method> \
    <method name="DisallowDevice"> \
      <arg type="s" name="path" direction="in"/> \
    </method> \
    <method name="ListDevices"> \
      <arg type="ao" name="result" direction="out"/> \
    </method> \
    <signal name="DeviceAdded"> \
      <arg type="s" name="path" direction="out"/> \
    </signal> \
    <signal name="DeviceRemoved"> \
      <arg type="s" name="path" direction="out"/> \
    </signal> \
  </interface> \
</node> \
');

ManagerNode.nodes.forEach((nodeInfo) => { nodeInfo.cache_build(); });


// Start the service backend
function startService() {
    try {
        GLib.spawn_command_line_async("mconnect -d");
    } catch (e) {
        log("Error spawning MConnect daemon: " + e);
    }
}


// Open the extension preferences window
function startSettings() {
    try {
        GLib.spawn_command_line_async(
            "xdg-open " + GLib.get_user_config_dir() + "/mconnect/mconnect.conf"
        );
    } catch (e) {
        log("Error spawning MConnect settings: " + e);
    }
}


var ProxyBase = new Lang.Class({
    Name: "ProxyBase",
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
    Name: "Battery",
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
        this.connect("g-properties-changed", (proxy, properties) => {
            properties = properties.deep_unpack();
            
            if (properties.hasOwnProperty("Charging")) {
                this.notify("charging");
            }
            
            if (properties.hasOwnProperty("Level")) {
                this.notify("level");
            }
        });
    },
    
    get charging () { return this._get("Charging"); },
    get level () { return this._get("Level"); }
});

/** A base class for backend Device implementations */
var Device = new Lang.Class({
    Name: "Device",
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
                if (name === "Id") {
                    this.notify("id");
                } else if (name === "Name") {
                    this.notify("name");
                } else if (name === "IsActive" || name === "IsConnected") {
                    this.notify("reachable");
                } else if (name === "Allowed" || name === "IsPaired") {
                    this.notify("trusted");
                } else if (name === "DeviceType") {
                    this.notify("type");
                }
            }
            
            this._reloadPlugins();
        });
        
        this._reloadPlugins();
    },
    
    // Properties
    get id () { return this._get("Id"); },
    get mounted () { return false; }, // Unsupported
    set mounted (bool) { return; }, // Unsupported
    get name () { return this._get("Name"); },
    get reachable () {
        return (this._get("IsActive") || this._get("IsConnected")) === true;
    },
    get trusted () { return this._get("Allowed") === true; },
    get type () { return this._get("DeviceType"); },
    
    // Methods
    mount: function () { throw Error("Not Implemented"); },
    pair: function () {
        this._manager._call(
            "AllowDevice",
            new GLib.Variant("(s)", [this.gObjectPath]),
            true
        );
    },
    ping: function () { throw Error("Not Implemented"); },
    ring: function () { throw Error("Not Implemented"); },
    sms: function (number, message) { throw Error("Not Implemented"); },
    shareURI: function (uri) { throw Error("Not Implemented"); },
    unpair: function () {
        this._manager._call(
            "DisallowDevice",
            new GLib.Variant("(s)", [this.gObjectPath]),
            true
        );
    },
    
    //
    _reloadPlugins: function () {
        // FIXME: when Device has gone inactive
        let incoming = this._get("IncomingCapabilities");
        let outgoing = this._get("OutgoingCapabilities");
        
        if (outgoing.indexOf("kdeconnect.battery") > -1 && this.trusted) {
            this.battery = new Battery(this.gObjectPath);
            
            this.battery.connect("notify", (battery) => {
                this.emit("changed::battery",
                    new GLib.Variant(
                        "(bu)",
                        [this.battery.charging, this.battery.level]
                    )
                );
            });
            
            // Kickstart the plugin
            this.emit("changed::battery",
                new GLib.Variant(
                    "(bu)",
                    [this.battery.charging, this.battery.level]
                )
            );
        } else if (this.hasOwnProperty("battery")) {
            this.battery.destroy();
            delete this.battery;
        }
        
        if (outgoing.indexOf("kdeconnect.ping") > -1 && this.trusted) {
            this.ping = new ProxyBase(
                DeviceNode.interfaces[3],
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("ping")) {
            this.ping.destroy();
            delete this.ping;
        }
        
        this.emit("changed::plugins", new GLib.Variant("()", ""));
    },
    
    // Override Methods
    destroy: function () {
        ["battery",
        "findmyphone",
        "ping",
        "share",
        "telephony"].forEach((plugin) => {
            if (this.hasOwnProperty(plugin)) {
                delete this[plugin];
            }
        });
        
        ProxyBase.prototype.destroy.call(this);
    }
});


// A DBus Interface wrapper for a device manager
var DeviceManager = new Lang.Class({
    Name: "DeviceManager",
    Extends: ProxyBase,
    Properties: {
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The host's device name",
            GObject.ParamFlags.READABLE,
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
        this.parent(ManagerNode.interfaces[0], "/org/mconnect/manager");
        
        // Track our device proxies, DBus path as key
        this.devices = new Map();
        
        // Track scan request ID's
        this._scans = new Map();
        
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            if (name === "DeviceAdded") {
                this._deviceAdded(this, parameters[0]);
            } else if (name === "DeviceRemoved") {
                this._deviceRemoved(this, parameters[0]);
            }
        });
        
        // Add currently managed devices
        this._call("ListDevices", false).forEach((dbusPath) => {
            this._deviceAdded(this, dbusPath);
        });
    },
    
    // MConnect always reports username@hostname
    get name () { return GLib.get_user_name() + "@" + GLib.get_host_name(); },
    set name (name) { log("Not implemented"); },
    get scanning () { return (this._scans.length > 0); },
    
    // Callbacks
    _deviceAdded: function (manager, dbusPath) {
        // NOTE: not actually a signal yet
        this.devices.set(dbusPath, new Device(this, dbusPath));
        this.emit("device::added", dbusPath);
    },
    
    _deviceRemoved: function (manager, dbusPath) {
        // NOTE: not actually a signal yet
        this.devices.get(dbusPath).destroy();
        this.devices.delete(dbusPath);
        this.emit("device::removed", dbusPath);
    },
    
    // Public Methods
    scan: function (requestId="manager", timeout=15) {
        if (this._scans.has(requestId)) {
            log("Not implemented");
            
            if (this._scans.get(requestId) > 0) {
                GLib.source_remove(this._scans.get(requestId));
            }
            
            this._scans.delete(requestId)
            this.notify("scanning");
            return false;
        } else {
            log("Not implemented");
            
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

