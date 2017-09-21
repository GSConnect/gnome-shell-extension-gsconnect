"use strict";

// Imports
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

imports.searchPath.push(getPath());

const { initTranslations, Me, DBusInfo, Settings } = imports.lib;


// DBus Constants
var BUS_NAME = "org.gnome.shell.extensions.gsconnect.daemon";

const DeviceNode = DBusInfo.device;
const ManagerNode = DBusInfo.daemon;


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
            -1, 100,
            0
        )
    },
    
    _init: function (dbusPath) {
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.battery"),
            dbusPath
        );
        
        //
        this.connect("g-properties-changed", (proxy, properties) => {
            properties = properties.deep_unpack();
            
            if (properties.hasOwnProperty("charging")) {
                this.notify("charging");
            }
            
            if (properties.hasOwnProperty("level")) {
                this.notify("level");
            }
        });
    },
    
    get charging () { return this._get("charging"); },
    get level () { return this._get("level"); }
});


/** A base class for backend Telephony implementations */
var Telephony = new Lang.Class({
    Name: "Telephony",
    Extends: ProxyBase,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        }
    },
    
    _init: function (dbusPath) {
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.telephony"),
            dbusPath
        );
        
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            log("signal name: " + name);
            log("signal typeof name: " + typeof name);
            log("signal params: " + parameters);
            
            if (name === "missedCall") {
                this.emit("missedCall",
                    parameters[0],
                    parameters[1],
                    parameters[2],
                    parameters[3]
                );
            } else if (name === "ringing") {
                this.emit("ringing",
                    parameters[0],
                    parameters[1],
                    parameters[2],
                    parameters[3]
                );
            } else if (name === "sms") {
                this.emit("sms",
                    parameters[0],
                    parameters[1],
                    parameters[2],
                    parameters[3]
                );
            } else if (name === "talking") {
                this.emit("talking",
                    parameters[0],
                    parameters[1],
                    parameters[2],
                    parameters[3]
                );
            }
        });
    },
    
    mute: function () {
        return this._call("mute", true);
    },
    
    sms: function (phoneNumber, messageBody) {
        this._call("sms", true, phoneNumber, messageBody);
    },
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
        "connected": GObject.ParamSpec.boolean(
            "connected",
            "DeviceReachable",
            "Whether the device is connected/online",
            GObject.ParamFlags.READABLE,
            false
        ),
        "paired": GObject.ParamSpec.boolean(
            "paired",
            "DeviceTrusted",
            "Whether the device is paired or not",
            GObject.ParamFlags.READABLE,
            false
        ),
        "plugins": GObject.param_spec_variant(
            "plugins",
            "PluginsList", 
            "A list of enabled plugins",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
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
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.device"),
            dbusPath
        );
        
        this._manager = manager;
        
        // Connect to PropertiesChanged
        this.connect("g-properties-changed", (proxy, properties) => {
            properties = properties.deep_unpack();
            
            for (let name in properties) {
                if (name === "id") {
                    this.notify("id");
                } else if (name === "name") {
                    this.notify("name");
                } else if (name === "connected") {
                    this.notify("connected");
                } else if (name === "paired") {
                    this.notify("paired");
                } else if (name === "plugins") {
                    this.notify("plugins");
                } else if (name === "type") {
                    this.notify("type");
                }
            }
            
            this._reloadPlugins();
        });
        
        this._reloadPlugins();
    },
    
    // Properties
    get id () { return this._get("id"); },
    get mounted () { return false; }, // TODO: Unsupported
    set mounted (bool) { return; }, // TODO: Unsupported
    get name () { return this._get("name"); },
    get connected () { return this._get("connected") === true; },
    get paired () { return this._get("paired") === true; },
    get plugins () {
        let plugins = this._get("plugins");
        return (plugins !== null) ? plugins : [];
    }, // TODO: returns null sometimes?
    get type () { return this._get("type"); },
    
    // Methods
    mount: function () { throw Error("Not Implemented"); }, // TODO: Unsupported
    pair: function () { this._call("pair", true); },
    ping: function () { this._call("ping", true); },
    ring: function () { this.findmyphone._call("ring", true); },
    sms: function (number, message) {
        this.telephony._call("sms", true, number, message);
    },
    shareURI: function (uri) { this.findmyphone._call("share", true, uri); },
    unpair: function () { this._call("unpair", true); },
    
    //
    _reloadPlugins: function () {
        if (this.plugins.indexOf("battery") > -1 && this.paired) {
            this.battery = new Battery(this.gObjectPath);
            
            this.battery.connect("notify", (battery) => {
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
        
        if (this.plugins.indexOf("findmyphone") > -1 && this.paired) {
            this.findmyphone = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.findmyphone"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("findmyphone")) {
            this.findmyphone.destroy();
            delete this.findmyphone;
        }
        
        if (this.plugins.indexOf("ping") > -1 && this.paired) {
            this.ping = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.ping"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("ping")) {
            this.ping.destroy();
            delete this.ping;
        }
        
        if (this.plugins.indexOf("share") > -1 && this.paired) {
            this.share = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.share"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("share")) {
            this.share.destroy();
            delete this.share;
        }
        
        if (this.plugins.indexOf("telephony") > -1 && this.paired) {
            this.telephony = new Telephony(this.gObjectPath);
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
        this.parent(ManagerNode.interfaces[0], "/org/gnome/shell/extensions/gsconnect/daemon");
        
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
        this._get("devices").forEach((id) => {
            let dbusPath = "/org/gnome/shell/extensions/gsconnect/device/" + id;
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

