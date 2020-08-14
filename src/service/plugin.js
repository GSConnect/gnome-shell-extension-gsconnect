'use strict';

const ByteArray = imports.byteArray;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;


/**
 * Base class for device plugins.
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPlugin',
}, class Plugin extends GObject.Object {

    _init(device, name) {
        super._init();

        this._device = device;
        this._name = name;
        this._info = imports.service.plugins[name].Metadata;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(this._info.id, false),
            path: `${device.settings.path}plugin/${name}/`,
        });

        // GActions
        this._gactions = [];

        if (this._info.actions) {
            let menu = this.device.settings.get_strv('menu-actions');

            for (let name in this._info.actions) {
                let info = this._info.actions[name];
                this._registerAction(name, menu.indexOf(name), info);
            }
        }
    }

    get device() {
        return this._device;
    }

    get name() {
        return this._name;
    }

    get service() {
        if (this._service === undefined)
            this._service = Gio.Application.get_default();

        return this._service;
    }

    _activateAction(action, parameter) {
        try {
            let args = null;

            if (parameter instanceof GLib.Variant)
                args = parameter.full_unpack();

            if (Array.isArray(args))
                this[action.name](...args);
            else
                this[action.name](args);
        } catch (e) {
            logError(e, action.name);
        }
    }

    _registerAction(name, menuIndex, info) {
        try {
            // Device Action
            let action = new Gio.SimpleAction({
                name: name,
                parameter_type: info.parameter_type,
                enabled: false,
            });
            action.connect('activate', this._activateAction.bind(this));

            this.device.add_action(action);

            // Menu
            if (menuIndex > -1) {
                this.device.addMenuAction(
                    action,
                    menuIndex,
                    info.label,
                    info.icon_name
                );
            }

            this._gactions.push(action);
        } catch (e) {
            logError(e, `${this.device.name}: ${this.name}`);
        }
    }

    /**
     * Called when the device connects.
     */
    connected() {
        // Enabled based on device capabilities, which might change
        let incoming = this.device.settings.get_strv('incoming-capabilities');
        let outgoing = this.device.settings.get_strv('outgoing-capabilities');

        for (let action of this._gactions) {
            let info = this._info.actions[action.name];

            if (info.incoming.every(type => outgoing.includes(type)) &&
                info.outgoing.every(type => incoming.includes(type)))
                action.set_enabled(true);
        }
    }

    /**
     * Called when the device disconnects.
     */
    disconnected() {
        for (let action of this._gactions)
            action.set_enabled(false);
    }

    /**
     * Called when a packet is received that the plugin is a handler for.
     *
     * @param {Core.Packet} packet - A KDE Connect packet
     */
    handlePacket(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Cache JSON parseable properties on this object for persistence. The
     * filename ~/.cache/gsconnect/<device-id>/<plugin-name>.json will be used
     * to store the properties and values.
     *
     * Calling cacheProperties() opens a JSON cache file and reads any stored
     * properties and values onto the current instance. When destroy()
     * is called the properties are automatically stored in the same file.
     *
     * @param {Array} names - A list of this object's property names to cache
     */
    async cacheProperties(names) {
        try {
            this.__cache_properties = names;

            // Ensure the device's cache directory exists
            let cachedir = GLib.build_filenamev([
                Config.CACHEDIR,
                this.device.id,
            ]);
            GLib.mkdir_with_parents(cachedir, 448);

            this._cacheFile = Gio.File.new_for_path(
                GLib.build_filenamev([cachedir, `${this.name}.json`])
            );

            // Read the cache from disk
            let cache = await new Promise((resolve, reject) => {
                this._cacheFile.load_contents_async(null, (file, res) => {
                    try {
                        let contents = file.load_contents_finish(res)[1];

                        resolve(JSON.parse(ByteArray.toString(contents)));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            Object.assign(this, cache);
        } catch (e) {
            debug(e.message, `${this.device.name}: ${this.name}`);
        } finally {
            this.cacheLoaded();
        }
    }

    /**
     * An overridable function that is invoked when the on-disk cache is being
     * cleared. Implementations should use this function to clear any in-memory
     * cache data.
     */
    clearCache() {}

    /**
     * An overridable function that is invoked when the cache is done loading
     */
    cacheLoaded() {}

    /**
     * Unregister plugin actions, write the cache (if applicable) and destroy
     * any dangling signal handlers.
     */
    destroy() {
        for (let action of this._gactions) {
            this.device.removeMenuAction(`device.${action.name}`);
            this.device.remove_action(action.name);
        }

        // Write the cache to disk synchronously
        if (this._cacheFile !== undefined) {
            try {
                // Build the cache
                let cache = {};

                for (let name of this.__cache_properties)
                    cache[name] = this[name];

                this._cacheFile.replace_contents(
                    JSON.stringify(cache, null, 2),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
            } catch (e) {
                debug(e.message, `${this.device.name}: ${this.name}`);
            }
        }

        // Try to avoid any cyclic references from signal handlers
        GObject.signal_handlers_destroy(this.settings);
        GObject.signal_handlers_destroy(this);
    }
});

