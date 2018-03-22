"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Protocol = imports.service.protocol;
const DBus = imports.modules.dbus;
const Device = imports.service.device;


/**
 * Base class for plugins
 */
var Plugin = GObject.registerClass({
    GTypeName: "GSConnectPlugin",
    Properties: {
        "allow": GObject.ParamSpec.int(
            "allow",
            "AllowTraffic",
            "The directions in which to allow traffic",
            GObject.ParamFlags.READABLE,
            1, 8,
            1
        ),
        "device": GObject.ParamSpec.object(
            "device",
            "WindowDevice",
            "The device associated with this window",
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "PluginName",
            "The name of the plugin",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    Signals: {
        "destroy": {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    }
}, class Plugin extends GObject.Object {

    _init(device, name) {
        super._init();

        this._device = device;
        this._name = name;
        this._meta = imports.service.plugins[name].Metadata;

        // Export DBus
        let iface = gsconnect.dbusinfo.lookup_interface(this._meta.id);

        if (iface) {
            this._dbus = new DBus.ProxyServer({
                g_interface_info: iface,
                g_instance: this // TODO: the object to export
            });
            this.device._dbus_object.add_interface(this._dbus);
        }

        // Init GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this._meta.id, -1),
            path: gsconnect.settings.path + ["device", device.id, "plugin", name, ""].join("/")
        });

        // GActions
        if (this._meta.actions) {
            // We register actions based on the device capabilities
            this._gactions = [];
            let deviceHandles = this.device.incomingCapabilities;
            let deviceProvides = this.device.outgoingCapabilities;

            for (let name in this._meta.actions) {
                let meta = this._meta.actions[name];

                if (meta.incoming.every(p => deviceProvides.indexOf(p) > -1) &&
                    meta.outgoing.every(p => deviceHandles.indexOf(p) > -1)) {
                    this._registerAction(name, meta);
                }
            }

            // TODO: other triggers...
            // We enabled/disable actions based on user settings
            this.settings.connect("changed::allow", () => {
                this._gactions.map(action => {
                    action.set_enabled(action.allow & this.allow);
                });
            });
        }
    }

    _activateAction(action, parameter) {
        try {
            if (parameter) {
                this[action.name].call(this, gsconnect.full_unpack(parameter));
            } else {
                this[action.name].call(this);
            }
        } catch(e) {
            debug(e);
        }
    }

    _registerAction(name, meta) {
        let action = new Device.Action({
            name: name,
            meta: meta,
            parameter_type: (meta.signature) ? new GLib.VariantType(meta.signature) : null
        }, this);
        action.set_enabled(action.allow & this.allow);

        action.connect("activate", this._activateAction.bind(this));

        this.device.add_action(action);

        if (action.parameter_type === null) {
            this.device.menu.add(action.name, action.meta);
        }

        this._gactions.push(action);
    }

    /**
     * A convenience for retrieving the allow flags for a packet handler
     */
    get allow() {
        return this.settings.get_uint("allow");
    }

    set allow(value) {
        if (typeof value !== "number") {
            throw TypeError("expected uint not " + typeof value);
        }

        this.settings.set_uint("allow", value);
    }

    get device() {
        return this._device;
    }

    get name() {
        return this._name;
    }

    /**
     * Emit an event on the device
     */
    event(type, data) {
        this.device.emit("event", type, gsconnect.full_pack(data));
    }

    /**
     *
     */
    handlePacket(packet) { throw Error("Not implemented"); }

    /**
     * Cache JSON parseable properties on this object for persistence. The
     * filename ~/.cache/gsconnect/<plugin>/<device-id>.json will be used to
     * store the properties and values.
     *
     * Calling cacheProperties() opens a JSON cache file and reads any stored
     * properties and values onto the current instance. When destroy()
     * is called the properties are automatically stored in the same file.
     *
     * @param {array} names - A list of this object's property names to cache
     */
    cacheProperties(names) {
        this._cacheDir =  GLib.build_filenamev([gsconnect.cachedir, this.name]);
        GLib.mkdir_with_parents(this._cacheDir, 448);

        this._cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._cacheDir, this.device.id + ".json"])
        );

        this._cacheProperties = {};

        for (let name of names) {
            // Make a copy of the default, if it exists
            if (this.hasOwnProperty(name)) {
                this._cacheProperties[name] = JSON.parse(JSON.stringify(this[name]));
            }
        }

        this._readCache();
    }

    cacheFile(bytes) {
    }

    // A DBus method for clearing the cache
    clearCache() {
        for (let name in this._cacheProperties) {
            debug("clearing '" + name + "' from '" + this.name + "'");
            this[name] = JSON.parse(JSON.stringify(this._cacheProperties[name]));
        }
    }

    // An overridable function that gets called before the cache is written
    _filterCache(names) {
        return;
    }

    _readCache() {
        try {
            let cache = JSON.parse(this._cacheFile.load_contents(null)[1]);

            for (let name in this._cacheProperties) {
                if (typeof this[name] === typeof cache[name]) {
                    this[name] = cache[name];
                }
            }
        } catch (e) {
            debug("Cache: Error reading %s cache: %s".format(this.name, e.message));
        }
    }

    _writeCache() {
        this._filterCache(this._cacheProperties);

        let cache = {};

        for (let name in this._cacheProperties) {
            cache[name] = this[name];
        }

        try {
            this._cacheFile.replace_contents(
                JSON.stringify(cache),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            debug("Cache: Error writing %s cache: %s".format(this._name, e.message));
        }
    }

    /**
     * The destroy function
     */
    destroy() {
        this.emit("destroy");

        this._gactions.map(action => this.device.remove_action(action.name));

        if (this._cacheFile) {
            this._writeCache();
        }

        // FIXME
        if (this._dbus) {
            this.device._dbus_object.remove_interface(this._dbus);
        }

        GObject.signal_handlers_destroy(this.settings);
        GObject.signal_handlers_destroy(this);
    }
});

