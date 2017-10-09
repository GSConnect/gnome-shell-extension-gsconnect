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

const Common = imports.common;


// DBus Constants
var BUS_NAME = "org.gnome.shell.extensions.gsconnect.daemon";

const DeviceNode = Common.DBusInfo.device;
const ManagerNode = Common.DBusInfo.daemon;


var ProxyBase = new Lang.Class({
    Name: "GSConnectProxyBase",
    Extends: Gio.DBusProxy,
    
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
    Name: "GSConnectBatteryProxy",
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
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },
    
    get charging () { return this._get("charging"); },
    get level () { return this._get("level"); }
});


/** A base class for backend Battery implementations */
var SFTP = new Lang.Class({
    Name: "GSConnectSFTPProxy",
    Extends: ProxyBase,
    Properties: {
        "directories": GObject.param_spec_variant(
            "directories",
            "mountedDirectories",
            "Directories on the mounted device",
            new GLib.VariantType("a{sv}"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "mounted": GObject.ParamSpec.boolean(
            "mounted",
            "deviceMounted",
            "Whether the device is mounted",
            GObject.ParamFlags.READABLE,
            false
        )
    },
    
    _init: function (dbusPath) {
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.sftp"),
            dbusPath
        );
        
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },
    
    get directories () { return this._get("directories"); },
    get mounted () { return this._get("mounted") === true; },
    
    mount: function () { this._call("mount", true); }
});


/** A base class for backend Telephony implementations */
var Telephony = new Lang.Class({
    Name: "GSConnectTelephonyProxy",
    Extends: ProxyBase,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // FIXME: phoneThumbnail
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        }
    },
    
    _init: function (dbusPath) {
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.telephony"),
            dbusPath
        );
        
        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            
            if (name === "missedCall") {
                this.emit("missedCall",
                    parameters[0],
                    parameters[1]
                );
            } else if (name === "ringing") {
                this.emit("ringing",
                    parameters[0],
                    parameters[1]
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
                    parameters[1]
                );
            }
        });
    },
    
    muteCall: function () {
        return this._call("muteCall", true);
    },
    
    openSms: function () {
        return this._call("openSms", true);
    },
    
    // TODO
    replySms: function () {
        return this._call("replySms", true);
    },
    
    sendSms: function (phoneNumber, messageBody) {
        this._call("sendSms", true, phoneNumber, messageBody);
    },
});


/** A base class for backend Device implementations */
var Device = new Lang.Class({
    Name: "GSConnectDeviceProxy",
    Extends: ProxyBase,
    Properties: {
        "connected": GObject.ParamSpec.boolean(
            "connected",
            "deviceConnected",
            "Whether the device is connected",
            GObject.ParamFlags.READABLE,
            false
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "deviceFingerprint",
            "SHA1 fingerprint for the device certificate",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "id": GObject.ParamSpec.string(
            "id",
            "deviceId",
            "The device id/hostname",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "deviceName",
            "The device name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "paired": GObject.ParamSpec.boolean(
            "paired",
            "devicePaired",
            "Whether the device is paired",
            GObject.ParamFlags.READWRITE,
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
        "supportedPlugins": GObject.param_spec_variant(
            "supportedPlugins",
            "SupportedPluginsList", 
            "A list of supported plugins",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "deviceType",
            "The device type",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    
    _init: function (dbusPath) {
        this.parent(
            DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.device"),
            dbusPath
        );
        
        // Connect to PropertiesChanged
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                // We'll call notify() later for our own plugins property
                if (name === "plugins") {
                    this._pluginsChanged();
                } else {
                    this.notify(name);
                }
            }
        });
        
        this._pluginsChanged();
    },
    
    // Properties
    get connected () { return this._get("connected") === true; },
    get fingerprint () { return this._get("fingerprint"); },
    get id () { return this._get("id"); },
    get name () { return this._get("name"); },
    get paired () { return this._get("paired") === true; },
    // FIXME: returns null sometimes?
    get plugins () {
        let plugins = this._get("plugins");
        return (plugins !== null) ? plugins : [];
    },
    get supportedPlugins () { return this._get("supportedPlugins"); },
    get type () { return this._get("type"); },
    
    // Device Connection/Pairing
    activate: function () { this._call("activate", true); },
    pair: function () { this._call("pair", true); },
    unpair: function () { this._call("unpair", true); },
    
    ping: function () { this._call("ping", true); },
    ring: function () { this.findmyphone._call("ring", true); },
    shareDialog: function () { this.share._call("shareDialog", true); },
    shareUri: function (uri) { this.share._call("shareUri", true, uri); },
    
    // Plugin Control
    enablePlugin: function (name) {
        return this._call("enablePlugin", false, name);
    },
    disablePlugin: function (name) {
        return this._call("disablePlugin", false, name);
    },
    configurePlugin: function (name, obj) {
        return this._call("configurePlugin", false, name, JSON.stringify(obj));
    },
    reloadPlugins: function () {
        return this._call("reloadPlugins", true);
    },
    
    _pluginsChanged: function () {
        if (this.plugins.indexOf("battery") > -1) {
            this.battery = new Battery(this.gObjectPath);
        } else if (this.hasOwnProperty("battery")) {
            this.battery.destroy();
            delete this.battery;
        }
        
        if (this.plugins.indexOf("findmyphone") > -1) {
            this.findmyphone = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.findmyphone"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("findmyphone")) {
            this.findmyphone.destroy();
            delete this.findmyphone;
        }
        
        if (this.plugins.indexOf("ping") > -1) {
            this.ping = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.ping"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("ping")) {
            this.ping.destroy();
            delete this.ping;
        }
        
        if (this.plugins.indexOf("sftp") > -1) {
            this.sftp = new SFTP(this.gObjectPath);
        } else if (this.hasOwnProperty("sftp")) {
            this.sftp.destroy();
            delete this.share;
        }
        
        if (this.plugins.indexOf("share") > -1) {
            this.share = new ProxyBase(
                DeviceNode.lookup_interface("org.gnome.shell.extensions.gsconnect.share"),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("share")) {
            this.share.destroy();
            delete this.share;
        }
        
        if (this.plugins.indexOf("telephony") > -1) {
            this.telephony = new Telephony(this.gObjectPath);
        } else if (this.hasOwnProperty("telephony")) {
            this.telephony.destroy();
            delete this.telephony;
        }
        
        this.notify("plugins");
    },
    
    destroy: function () {
        ["battery",
        "findmyphone",
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


var Daemon = new Lang.Class({
    Name: "GSConnectDaemonProxy",
    Extends: ProxyBase,
    Properties: {
        "discovering": GObject.ParamSpec.boolean(
            "discovering",
            "DiscoveringDevices",
            "Whether the daemon is discovering devices",
            GObject.ParamFlags.READABLE,
            false
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "daemonFingerprint",
            "SHA1 fingerprint for the device certificate",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "DeviceName",
            "The host's device name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "version": GObject.ParamSpec.int(
            "version",
            "DaemonVersion",
            "The version of the running daemon",
            GObject.ParamFlags.READABLE,
            0
        )
    },
    Signals: {
        "device": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function () {
        this.parent(
            ManagerNode.lookup_interface("org.gnome.shell.extensions.gsconnect.daemon"),
            "/org/gnome/shell/extensions/gsconnect/daemon"
        );
        
        // Track our device proxies, DBus path as key
        this.devices = new Map();
        
        // Connect to PropertiesChanged
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                // Watch for new and removed devices
                if (name === "devices") {
                    this._devicesChanged();
                } else {
                    this.notify(name);
                }
            }
        });
        
        // Add currently managed devices
        this._devicesChanged();
    },
    
    get discovering () { return this._get("discovering"); },
    get fingerprint () { return this._get("fingerprint"); },
    get name () { return this._get("name"); },
    set name (name) { this._set("name", name); },
    get version () { return this._get("version"); },
    
    // Callbacks
    _devicesChanged: function () {
        let managedDevices = this._get("devices");
        managedDevices = (managedDevices === null) ? [] : managedDevices;
        
        for (let dbusPath of managedDevices) {
            if (!this.devices.has(dbusPath)) {
                this._deviceAdded(this, dbusPath);
            }
        }
        
        for (let dbusPath of this.devices.keys()) {
            if (managedDevices.indexOf(dbusPath) < 0) {
                this._deviceRemoved(this, dbusPath);
            }
        }
    },
    
    _deviceAdded: function (daemon, dbusPath) {
        this.devices.set(dbusPath, new Device(dbusPath));
        this.emit("device::added", dbusPath);
    },
    
    _deviceRemoved: function (daemon, dbusPath) {
        this.devices.get(dbusPath).destroy();
        this.devices.delete(dbusPath);
        this.emit("device::removed", dbusPath);
    },
    
    // Public Methods
    discover: function (requestId="daemon", timeout=15) {
        this._call("discover", true, requestId, timeout);
    },
    
    quit: function () {
        this._call("quit", true);
    },
    
    destroy: function () {
        for (let dbusPath of this.devices.keys()) {
            this._deviceRemoved(this, dbusPath);
        }
        
        ProxyBase.prototype.destroy.call(this);
    }
});

