"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Protocol = imports.service.protocol;


/**
 * Base class for plugins
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPlugin",
    Extends: GObject.Object,
    Properties: {
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
        "event": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING, GObject.TYPE_VARIANT ]
        },
        "destroy": {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    },

    _init: function (device, name) {
        this.parent();

        this._device = device;
        this._name = name;
        this._metadata = imports.service.plugins[name].METADATA;

        // Export DBus
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            gsconnect.dbusinfo.lookup_interface(this._metadata.uuid),
            this
        );
        this._dbus.export(Gio.DBus.session, device._dbus.get_object_path());

        // Init GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this._metadata.uuid, -1),
            path: gsconnect.settings.path + ["device", device.id, "plugin", name, ""].join("/")
        });

        // TODO TODO
        // Actions
        this._actions = [];
        let module = imports.service.plugins[name];
        let _in = this.device.incomingCapabilities;
        let _out = this.device.outgoingCapabilities;

        if (module.Action) {
            for (let name in module.Action) {
                let pluginAction = module.Action[name];

                if (pluginAction.incoming.every(p => _out.indexOf(p) > -1) &&
                    pluginAction.outgoing.every(p => _in.indexOf(p) > -1)) {

                    let action = new Gio.SimpleAction({
                        name: name,
                        parameter_type: new GLib.VariantType("s")
                    });
                    action.connect("activate", (action, parameter) => {
                        try {
                            let args = JSON.parse(unescape(parameter.unpack()));
                            this[name](...args);
                        } catch(e) {
                            debug(e.message + "\n" + e.stack);
                        }
                    });
                    this.device._actions.add_action(action);

                    this._actions.push(pluginAction);
                }
            }
        }
    },

    get device () {
        return this._device;
    },

    get name () {
        return this._name;
    },

    event: function (type, data) {
        // TODO: dbus emit
        let event = new GLib.Variant("a{sv}", Object.toVariant(data));
        this.emit("event", type, event)
    },

    notify: function (name, format=null) {
        GObject.Object.prototype.notify.call(this, name);

        if (format && this._dbus) {
            this._dbus.emit_property_changed(
                name,
                new GLib.Variant(format, this[name])
            );
        }
    },

    handlePacket: function (packet) { throw Error("Not implemented"); },

    /**
     *
     */
    send: function (packet) {
        this.sendPacket(packet);
    },

    sendPacket: function (obj) {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet(obj);
            this.device._channel.send(packet);
        }
    },

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
    cacheProperties: function (names) {
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
    },

    cacheFile: function (bytes) {
    },

    // A DBus method for clearing the cache
    ClearCache: function () {
        for (let name in this._cacheProperties) {
            debug("clearing '" + name + "' from '" + this.name + "'");
            this[name] = JSON.parse(JSON.stringify(this._cacheProperties[name]));
        }
    },

    // An overridable function that gets called before the cache is written
    _filterCache: function (names) {
        return;
    },

    _readCache: function () {
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
    },

    _writeCache: function () {
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
    },

    /**
     * The destroy function
     */
    destroy: function () {
        this.emit("destroy");

        // FIXME
        this._actions.map(name => this.device.remove_action(name));

        if (this._cacheFile) {
            this._writeCache();
        }

        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this.settings);
        GObject.signal_handlers_destroy(this);
    }
});

