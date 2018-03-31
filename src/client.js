"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;


// DBus Constants
var BUS_NAME = "org.gnome.Shell.Extensions.GSConnect";


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


/**
 * A DBus Proxy for the Battery plugin
 */
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
        ),
        "time": GObject.ParamSpec.int(
            "time",
            "timeRemaining",
            "Seconds until full or depleted",
            GObject.ParamFlags.READABLE,
            -1
        )
    },

    _init: function (dbusPath) {
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.Battery"
            ),
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
    get level () { return this._get("level"); },
    get time () { return this._get("time"); }
});


/**
 * A DBus Proxy for the Battery plugin
 */
var Notification = new Lang.Class({
    Name: "GSConnectNotificationProxy",
    Extends: ProxyBase,
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

    _init: function (dbusPath) {
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.Notification"
            ),
            dbusPath
        );

        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            this.emit(name, parameters[0]);
        });
    },

    close: function (id) {
        this._call("close", true, id);
    }
});


/**
 * A DBus Proxy for the RunCommand plugin
 */
var RunCommand = new Lang.Class({
    Name: "GSConnectRunCommandProxy",
    Extends: ProxyBase,
    Properties: {
        "commands": GObject.ParamSpec.string(
            "commands",
            "CommandList",
            "A string of JSON containing the remote commands",
            GObject.ParamFlags.READABLE,
            "{}"
        )
    },

    _init: function (dbusPath) {
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand"
            ),
            dbusPath
        );

        //
        this.connect("g-properties-changed", (proxy, properties) => {
            for (let name in properties.deep_unpack()) {
                this.notify(name);
            }
        });
    },

    get commands () { return this._get("commands"); },

    request: function () { this._call("request", true); },
    run: function (key) { this._call("run", true, key); }
});


/**
 * A DBus Proxy for the SFTP plugin
 */
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
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP"
            ),
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

    mount: function () { this._call("mount", true); },
    unmount: function () { this._call("unmount", true); }
});


/**
 * A DBus Proxy for the Share plugin
 */
var Share = new Lang.Class({
    Name: "GSConnectShareProxy",
    Extends: ProxyBase,
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

    _init: function (dbusPath) {
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.Share"
            ),
            dbusPath
        );

        this.connect("g-signal", (proxy, sender, name, parameters) => {
            parameters = parameters.deep_unpack();
            this.emit(name, parameters[0], parameters[1]);
        });
    },

    shareDialog: function () { this._call("shareDialog", true); },
    shareUri: function (uri) { this._call("shareUri", true, uri); }
});


/**
 * A DBus Proxy for the Telephony plugin
 */
var Telephony = new Lang.Class({
    Name: "GSConnectTelephonyProxy",
    Extends: ProxyBase,
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

    _init: function (dbusPath) {
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony"
            ),
            dbusPath
        );

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
        return this._call("muteCall", true);
    },

    openSms: function () {
        return this._call("openSms", true);
    },

    sendSms: function (phoneNumber, messageBody) {
        this._call("sendSms", true, phoneNumber, messageBody);
    },

    shareUri: function (url) {
        this._call("shareUri", true, url);
    }
});


/**
 * A DBus Proxy for Devices
 */
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
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Device"
            ),
            dbusPath
        );

        this.daemon = daemon;

        this.settings = new Gio.Settings({
            settings_schema: ext.gschema.lookup(
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

        this._pluginsChanged();
    },

    // Properties
    get connected () { return this._get("connected") === true; },
    get fingerprint () { return this._get("fingerprint"); },
    get id () { return this._get("id"); },
    get name () { return this._get("name"); },
    get paired () { return this._get("paired") === true; },
    get plugins () { return this._get("plugins") || []; },
    get supportedPlugins () { return this._get("supportedPlugins"); },
    get type () { return this._get("type"); },

    // Device Connection/Pairing
    activate: function () { this._call("activate", true); },
    pair: function () { this._call("pair", true); },
    unpair: function () { this._call("unpair", true); },

    ping: function () { this.ping._call("ping", true); },
    find: function () { this.findmyphone._call("find", true); },

    // Plugin Control
    enablePlugin: function (name) {
        return this._call("enablePlugin", false, name);
    },
    disablePlugin: function (name) {
        return this._call("disablePlugin", false, name);
    },
    openSettings: function () {
        this._call("openSettings", true);
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
                ext.dbusinfo.lookup_interface(
                    "org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone"
                ),
                this.gObjectPath
            );
        } else if (this.hasOwnProperty("findmyphone")) {
            this.findmyphone.destroy();
            delete this.findmyphone;
        }

        if (this.plugins.indexOf("ping") > -1) {
            this.ping = new ProxyBase(
                ext.dbusinfo.lookup_interface(
                    "org.gnome.Shell.Extensions.GSConnect.Plugin.Ping"
                ),
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
            delete this.sftp;
        }

        if (this.plugins.indexOf("notification") > -1) {
            this.notification = new Notification(this.gObjectPath);
        } else if (this.hasOwnProperty("notification")) {
            this.notification.destroy();
            delete this.notification;
        }

        if (this.plugins.indexOf("runcommand") > -1) {
            this.runcommand = new RunCommand(this.gObjectPath);
        } else if (this.hasOwnProperty("runcommand")) {
            this.runcommand.destroy();
            delete this.runcommand;
        }

        if (this.plugins.indexOf("share") > -1) {
            this.share = new Share(this.gObjectPath);
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
        "runcommand",
        "share",
        "telephony"].forEach((plugin) => {
            if (this.hasOwnProperty(plugin)) {
                this[plugin].destroy();
                delete this[plugin];
            }
        });

        GObject.signal_handlers_destroy(this.settings);

        ProxyBase.prototype.destroy.call(this);
    }
});


/**
 * A DBus Proxy for the Daemon
 */
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
        this.parent(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect"
            ),
            "/org/gnome/Shell/Extensions/GSConnect"
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

    get discovering () { return this._get("discovering") === true; },
    set discovering (bool) { this._set("discovering", bool); },
    get fingerprint () { return this._get("fingerprint"); },
    get name () { return this._get("name"); },
    set name (name) { this._set("name", name); },
    get type () { return this._get("type"); },

    // Callbacks
    _devicesChanged: function () {
        let managedDevices = this._get("devices");
        managedDevices = (managedDevices === null) ? [] : managedDevices;

        for (let dbusPath of managedDevices) {
            if (!this.devices.has(dbusPath)) {
                this.devices.set(dbusPath, new Device(dbusPath, this));
                this.emit("device::added", dbusPath);
            }
        }

        for (let dbusPath of this.devices.keys()) {
            if (managedDevices.indexOf(dbusPath) < 0) {
                this.devices.get(dbusPath).destroy();
                this.devices.delete(dbusPath);
                this.emit("device::removed", dbusPath);
            }
        }
    },

    // Public Methods
    broadcast: function () {
        this._call("broadcast", true);
    },

    quit: function () {
        this._call("quit", true);
    },

    destroy: function () {
        for (let dbusPath of this.devices.keys()) {
            this.devices.get(dbusPath).destroy();
            this.devices.delete(dbusPath);
            this.emit("device::removed", dbusPath);
        }

        ProxyBase.prototype.destroy.call(this);
    }
});

