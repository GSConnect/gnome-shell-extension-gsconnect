"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;


/**
 * A base class for plugin DBus Proxies
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPluginProxy",
    Extends: DBus.ProxyBase,

    _init: function (device, name) {
        let iface = gsconnect.dbusinfo.lookup_interface(
            "org.gnome.Shell.Extensions.GSConnect.Plugin." + name
        );
        this.parent({
            g_name: "org.gnome.Shell.Extensions.GSConnect",
            g_interface_info: iface,
            g_interface_name: iface.name,
            g_object_path: device.g_object_path
        });
        this.device = device;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                "org.gnome.Shell.Extensions.GSConnect.Plugin." + name,
                true
            ),
            path: "/org/gnome/shell/extensions/gsconnect/device/" +
                  device.id + "/plugin/" + name.toLowerCase() + "/"
        });
    }
});

/**
 * A DBus Proxy for the Battery plugin
 */
var Battery = new Lang.Class({
    Name: "GSConnectBatteryProxy",
    Extends: Plugin,
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
            "currentCharge",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            -1, 100,
            -1
        ),
        "time": GObject.ParamSpec.int(
            "time",
            "timeRemaining",
            "Seconds until full or depleted",
            GObject.ParamFlags.READABLE,
            -1, GLib.MAXINT32,
            -1
        )
    },

    _init: function (device) {
        this.parent(device, "Battery");

        //
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },

    get charging () { return this._get("charging"); },
    get level () { return this._get("level") || -1; },
    get time () { return this._get("time"); }
});


/**
 * A DBus Proxy for the Clipboard plugin
 */
var Clipboard = new Lang.Class({
    Name: "GSConnectClipboardProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "Clipboard");
    }
});


/**
 * A DBus Proxy for the Contacts plugin
 */
var Contacts = new Lang.Class({
    Name: "GSConnectContactsProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "Contacts");
    }
});


/**
 * A DBus Proxy for the FindMyPhone plugin
 */
var FindMyPhone = new Lang.Class({
    Name: "GSConnectFindMyPhoneProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "FindMyPhone");

//        this._wrapObject();
//    }
    },

    find: function () {
        this._call("find");
    }
});


/**
 * A DBus Proxy for the Lock plugin
 */
var Lock = new Lang.Class({
    Name: "GSConnectLockProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "Lock");
    }
});


/**
 * A DBus Proxy for the Mousepad plugin
 */
var Mousepad = new Lang.Class({
    Name: "GSConnectMousepadProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "Mousepad");
    }
});


/**
 * A DBus Proxy for the MPRIS plugin
 */
var MPRIS = new Lang.Class({
    Name: "GSConnectMPRISProxy",
    Extends: Plugin,

    _init: function (device) {
        this.parent(device, "MPRIS");
    }
});


/**
 * A DBus Proxy for the Notification plugin
 */
var Notification = new Lang.Class({
    Name: "GSConnectNotificationProxy",
    Extends: Plugin,
    Properties: {
        "notifications": GObject.param_spec_variant(
            "notifications",
            "NotificationList",
            "A list of active or expected notifications",
            new GLib.VariantType("aa{sv}"),
            new GLib.Variant("aa{sv}", []),
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        },
        "dismissed": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function (device) {
        this.parent(device, "Notification");

//        this._wrapObject({
//            Notifications: () => { this.notify("notifications") }
//        });

        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name.toLowerCase()); // FIXME
            }
        });

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            this.emit(name, parameters[0]);
        });
    },

    get notifications() {
        return this._get("Notifications").map(notif => Object.fromVariant(notif));
    },

    // TODO: all the cache stuff
    clearCache: function () {
        this._call("ClearCache");
    },

    close: function (id) {
        this._call("Close", id);
    }
});


/**
 * A DBus Proxy for the Ping plugin
 */
var Ping = new Lang.Class({
    Name: "GSConnectPingProxy",
    Extends: Plugin,
    Signals: {
        "ping": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function (device) {
        this.parent(device, "Ping");

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            this.emit(name, parameters[0]);
        });
    },

    ping: function (message=null) { this._call("ping", message); }
});


/**
 * A DBus Proxy for the RunCommand plugin
 */
var RunCommand = new Lang.Class({
    Name: "GSConnectRunCommandProxy",
    Extends: Plugin,
    Properties: {
        "commands": GObject.ParamSpec.string(
            "commands",
            "CommandList",
            "A string of JSON containing the remote commands",
            GObject.ParamFlags.READABLE,
            "{}"
        )
    },

    _init: function (device) {
        this.parent(device, "RunCommand");

        //
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },

    get commands () { return this._get("commands"); },

    request: function () { this._call("request"); },
    run: function (key) { this._call("run", key); }
});


/**
 * A DBus Proxy for the SFTP plugin
 */
var SFTP = new Lang.Class({
    Name: "GSConnectSFTPProxy",
    Extends: Plugin,
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

    _init: function (device) {
        this.parent(device, "SFTP");

        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },

    get directories () { return this._get("directories"); },
    get mounted () { return this._get("mounted") === true; },

    mount: function () { this._call("mount"); },
    unmount: function () { this._call("unmount"); }
});


/**
 * A DBus Proxy for the Share plugin
 */
var Share = new Lang.Class({
    Name: "GSConnectShareProxy",
    Extends: Plugin,
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "sent": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        }
    },

    _init: function (device) {
        this.parent(device, "Share");

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            this.emit(name, parameters[0], parameters[1]);
        });
    },

    shareDialog: function () { this._call("shareDialog"); },
    shareFile: function (uri) { this._call("shareUri", uri); },
    shareText: function (text) { this._call("shareText", text); },
    shareUrl: function (url) { this._call("shareUrl", url); }
});


/**
 * A DBus Proxy for the Telephony plugin
 */
var Telephony = new Lang.Class({
    Name: "GSConnectTelephonyProxy",
    Extends: Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        }
    },

    _init: function (device) {
        this.parent(device, "Telephony");

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();

            if (name === "missedCall") {
                this.emit("missedCall",
                    parameters[0],
                    parameters[1],
                    parameters[2]
                );
            } else if (name === "ringing") {
                this.emit("ringing",
                    parameters[0],
                    parameters[1],
                    parameters[2]
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
                    parameters[2]
                );
            }
        });
    },

    muteCall: function () {
        return this._call("muteCall");
    },

    openSms: function () {
        return this._call("openSms");
    },

    sendSms: function (phoneNumber, messageBody) {
        this._call("sendSms", phoneNumber, messageBody);
    },

    shareUri: function (url) {
        this._call("shareUri", url);
    }
});


var _PluginMap = {
    battery: Battery,
    clipboard: Clipboard,
    contacts: Contacts,
    findmyphone: FindMyPhone,
    lock: Lock,
    mousepad: Mousepad,
    mpris: MPRIS,
    notification: Notification,
    ping: Ping,
    runcommand: RunCommand,
    sftp: SFTP,
    share: Share,
    telephony: Telephony
};


/**
 * A DBus Proxy for Devices
 */
var Device = new Lang.Class({
    Name: "GSConnectDeviceProxy",
    Extends: DBus.ProxyBase,
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
            GObject.ParamFlags.READABLE,
            false
        ),
        "plugins": GObject.param_spec_variant(
            "plugins",
            "PluginsList",
            "A list of enabled plugins",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "incomingCapabilities": GObject.param_spec_variant(
            "incomingCapabilities",
            "IncomingCapabilitiesList",
            "A list of incoming packet types the device can receive",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "outgoingCapabilities": GObject.param_spec_variant(
            "outgoingCapabilities",
            "OutgoingCapabilitiesList",
            "A list of outgoing packet types the device can send",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "supportedPlugins": GObject.param_spec_variant(
            "supportedPlugins",
            "SupportedPluginsList",
            "A list of supported plugins",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
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

    _init: function (dbusPath, daemon) {
        let iface = gsconnect.dbusinfo.lookup_interface(
            "org.gnome.Shell.Extensions.GSConnect.Device"
        );
        this.parent({
            g_name: "org.gnome.Shell.Extensions.GSConnect",
            g_interface_info: iface,
            g_interface_name: iface.name,
            g_object_path: dbusPath
        });
        this.daemon = daemon;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                "org.gnome.Shell.Extensions.GSConnect.Device",
                true
            ),
            path: "/org/gnome/shell/extensions/gsconnect/device/" + this.id + "/"
        });

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

        // Mirror _plugins Map from service.device
        this._plugins = new Map();

        this._pluginsChanged();
    },

    // Properties
    get connected () { return this._get("connected") === true; },
    get fingerprint () { return this._get("fingerprint"); },
    get id () { return this._get("id"); },
    get name () { return this._get("name"); },
    get paired () { return this._get("paired") === true; },
    get plugins () { return Array.from(this._plugins.keys()) },
    get incomingCapabilities () { return this._get("incomingCapabilities") || []; },
    get outgoingCapabilities () { return this._get("outgoingCapabilities") || []; },
    get type () { return this._get("type"); },

    // Device Connection/Pairing
    activate: function () { this._call("activate"); },
    pair: function () { this._call("pair"); },
    unpair: function () { this._call("unpair"); },

    // FIXME
    find: function () {
        let plugin = this._plugins.get("findmyphone");

        if (plugin) {
            plugin._call("find");
        }
    },

    // Plugin Control
    openSettings: function () {
        this._call("openSettings");
    },

    _pluginsChanged: function () {
        let plugins = this._get("plugins") || [];

        for (let name of plugins) {
            if (this.plugins.indexOf(name) < 0) {
                this[name] = new _PluginMap[name](this);
                this._plugins.set(name, this[name]);
            }
        }

        this.notify("plugins");
    },

    destroy: function () {
        for (let [key, value] of this._plugins) {
            if (this.hasOwnProperty(key)) {
                delete this[key];
            }

            this._plugins.get(key).destroy();
            this._plugins.delete(key);
        }

        GObject.signal_handlers_destroy(this.settings);

        DBus.ProxyBase.prototype.destroy.call(this);
    }
});


/**
 * A DBus Proxy for the Daemon
 */
var Daemon = new Lang.Class({
    Name: "GSConnectDaemonProxy",
    Extends: DBus.ProxyBase,
    Properties: {
        "devices": GObject.param_spec_variant(
            "devices",
            "DevicesList",
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
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
        "type": GObject.ParamSpec.string(
            "type",
            "DeviceType",
            "The host's device type",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    Signals: {
        "device": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function () {
        let iface = gsconnect.dbusinfo.lookup_interface(
            "org.gnome.Shell.Extensions.GSConnect"
        );
        this.parent({
            g_name: "org.gnome.Shell.Extensions.GSConnect",
            g_interface_info: iface,
            g_interface_name: iface.name,
            g_object_path: "/org/gnome/Shell/Extensions/GSConnect"
        });

        // Track our device proxies, DBus path as key
        this._devices = new Map();

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

        //this._wrapObject({ devices: this._devicesChanged });

        // Add currently managed devices
        this._devicesChanged();
    },

    get devices () { return Array.from(this._devices.keys()); },
    get discovering () { return this._get("discovering") === true; },
    set discovering (bool) { this._set("discovering", bool); },
    get fingerprint () { return this._get("fingerprint"); },
    get name () { return this._get("name"); },
    set name (name) { this._set("name", name); },
    get type () { return this._get("type"); },

    // Callbacks
    _devicesChanged: function () {
        let managedDevices = this._get("devices") || [];

        for (let dbusPath of managedDevices) {
            if (!this._devices.has(dbusPath)) {
                this._devices.set(dbusPath, new Device(dbusPath, this));
                this.notify("devices");
            }
        }

        for (let dbusPath of this.devices) {
            if (managedDevices.indexOf(dbusPath) < 0) {
                this._devices.get(dbusPath).destroy();
                this._devices.delete(dbusPath);
                this.notify("devices");
            }
        }

        //this.notify("devices");
    },

    // Public Methods
    broadcast: function () {
        this._call("broadcast");
    },

    openSettings: function () {
        this._call("openSettings");
    },

    quit: function () {
        this._call("quit");
    },

    destroy: function () {
        for (let dbusPath of this.devices) {
            this._devices.get(dbusPath).destroy();
            this._devices.delete(dbusPath);
            this.notify("devices");
        }

        DBus.ProxyBase.prototype.destroy.call(this);
    }
});

