'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Device = imports.service.device;


/**
 * Base class for plugins
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPlugin',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'WindowDevice',
            'The device associated with this window',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'PluginName',
            'The name of the plugin',
            GObject.ParamFlags.READABLE,
            ''
        )
    },
    Signals: {
        'destroy': {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    }
}, class Plugin extends GObject.Object {

    _init(device, name) {
        super._init();

        this._device = device;
        this._name = name;
        this._meta = imports.service.plugins[name].Metadata;

        // Init GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this._meta.id, -1),
            path: `${gsconnect.settings.path}device/${device.id}/plugin/${name}/`
        });

        // GActions
        this._gactions = [];

        if (this._meta.actions) {
            // We register actions based on the device capabilities
            let deviceHandles = this.device.incomingCapabilities;
            let deviceProvides = this.device.outgoingCapabilities;
            let blacklist = this.device.settings.get_strv('action-blacklist');

            for (let name in this._meta.actions) {
                let meta = this._meta.actions[name];

                if (meta.incoming.every(p => deviceProvides.indexOf(p) > -1) &&
                    meta.outgoing.every(p => deviceHandles.indexOf(p) > -1)) {
                    this._registerAction(name, meta, blacklist);
                }
            }

            // TODO: other triggers...
            // We enabled/disable actions based on user settings
            this.device.settings.connect(
                'changed::action-blacklist',
                this._changeAction.bind(this)
            );
        }
    }

    _activateAction(action, parameter) {
        try {
            parameter = parameter ? gsconnect.full_unpack(parameter) : null;

            if (Array.isArray(parameter)) {
                this[action.name].apply(this, parameter);
            } else if (parameter) {
                this[action.name].call(this, parameter);
            } else {
                this[action.name].call(this);
            }
        } catch(e) {
            debug(e);
        }
    }

    _changeAction() {
        let blacklist = this.device.settings.get_strv('action-blacklist');

        this._gactions.map(action => {
            if (blacklist.indexOf(action.name) > -1) {
                action.set_enabled(false);
            }
        });
    }

    _registerAction(name, meta, blacklist) {
        let action = new Device.Action(Object.assign({ name: name }, meta));

        // Set the enabled state
        if (blacklist.indexOf(action.name) > -1) {
            action.set_enabled(false);
        }

        // Bind the activation
        action.connect('activate', this._activateAction.bind(this));

        this.device.add_action(action);

        this._gactions.push(action);
    }

    _eventActions(type, parameter) {
        let events = gsconnect.full_unpack(
            this.settings.get_value('events')
        );

        let actions = events.hasOwnProperty(type) ? events[type] : {};

        for (let name in actions) {
            if (actions[name] && name === 'dbusEmit') {
                this.device.emit('event', type, gsconnect.full_pack(data));
            } else if (actions[name]) {
                let action = this.device.lookup_action(name);

                if (action && action.enabled) {
                    if (action.parameter_type) {
                        action.activate(gsconnect.full_pack(parameter));
                    } else if (action) {
                        action.activate(null);
                    }
                }
            }
        }

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
        this.device.emit('event', type, gsconnect.full_pack(data));
    }

    /**
     *
     */
    handlePacket(packet) { throw Error('Not implemented'); }

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
            GLib.build_filenamev([this._cacheDir, this.device.id + '.json'])
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
            debug(`clearing ${name} from ${this.name}`);
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
            debug(`error reading ${this.name} cache: ${e.message}`);
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
            debug(`error writing ${this.name} cache: ${e.message}`);
        }
    }

    /**
     * The destroy function
     */
    destroy() {
        this.emit('destroy');

        this._gactions.map(action => {
            this.device.menu.remove_action(action.name);
            this.device.remove_action(action.name);
        });

        if (this._cacheFile) {
            this._writeCache();
        }

        GObject.signal_handlers_destroy(this.settings);
        GObject.signal_handlers_destroy(this);
    }
});

