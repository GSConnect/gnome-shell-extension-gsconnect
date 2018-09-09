'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/**
 * Base class for plugins
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectDevicePlugin'
}, class Plugin extends GObject.Object {

    _init(device, name) {
        super._init();

        this._device = device;
        this._name = name;
        this._meta = imports.service.plugins[name].Metadata;

        // Init GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this._meta.id, false),
            path: `${gsconnect.settings.path}device/${device.id}/plugin/${name}/`
        });

        // GActions
        this._gactions = [];

        if (this._meta.actions) {
            // Register based on device capabilities, which shouldn't change
            let deviceHandles = this.device.settings.get_strv('incoming-capabilities');
            let deviceProvides = this.device.settings.get_strv('outgoing-capabilities');
            let menu = this.device.settings.get_strv('menu-actions');
            let disabled = this.device.settings.get_strv('disabled-actions');

            for (let name in this._meta.actions) {
                let meta = this._meta.actions[name];

                if (meta.incoming.every(p => deviceProvides.includes(p)) &&
                    meta.outgoing.every(p => deviceHandles.includes(p))) {
                    this._registerAction(name, meta, menu, disabled);
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

    get service() {
        return Gio.Application.get_default();
    }

    _activateAction(action, parameter) {
        try {
            parameter = parameter ? parameter.full_unpack() : null;

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

    _registerAction(name, meta, menu, disabled) {
        let action = new Gio.SimpleAction({
            name: name,
            parameter_type: meta.parameter_type,
            state: new GLib.Variant('(ss)', [meta.label, meta.icon_name])
        });

        // Set the enabled state
        action.set_enabled(!disabled.includes(action.name));

        // Bind the activation
        action.connect('activate', this._activateAction.bind(this));

        this.device.add_action(action);

        // Menu
        let index = menu.indexOf(action.name);

        if (index > -1) {
            this.device.menu.add_action(action, index);
        }

        this._gactions.push(action);
    }

    /**
     * This is called when a packet is received the plugin is a handler for
     */
    handlePacket(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * These two methods are optional and called by the device in response to
     * the connection state changing.
     */
    connected() {}
    disconnected() {}

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
            // Ensure the device's cache directory exists
            this._cacheDir = GLib.build_filenamev([
                gsconnect.cachedir,
                this.device.id
            ]);
            GLib.mkdir_with_parents(this._cacheDir, 448);

            this._cacheFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._cacheDir, `${this.name}.json`])
            );

            this._cacheProperties = {};

            for (let name of names) {
                // Make a copy of the default, if it exists
                if (this.hasOwnProperty(name)) {
                    this._cacheProperties[name] = JSON.parse(JSON.stringify(this[name]));
                }
            }

            await this._readCache();
            await this.cacheLoaded();
        } catch (e) {
            logWarning(e.message, `${this.device.name}: ${this.name}`);
        }
    }

    // A method for clearing the cache
    cacheClear() {
        log(`${this.device.name}: clearing cache for ${this.name} plugin`);

        for (let name in this._cacheProperties) {
            this[name] = JSON.parse(JSON.stringify(this._cacheProperties[name]));
            this._writeCache();
        }
    }

    /**
     * An overridable function that is invoked when the cache is done loading
     */
    cacheLoaded() {}

    /**
     * Build a dictionary of properties and values to cache. This can be
     * overridden to filter what is written to disk.
     *
     * @return {Object} - A dictionary of the properties to cache
     */
    cacheBuild() {
        let cache = {};

        for (let name in this._cacheProperties) {
            cache[name] = this[name];
        }

        return cache;
    }

    /**
     * Read the plugin's cache from disk, asynchronously
     */
    _readCache() {
        return new Promise((resolve, reject) => {
            this._cacheFile.load_contents_async(null, (file, res) => {
                try {
                    let cache = file.load_contents_finish(res)[1];
                    cache = JSON.parse(cache);

                    for (let name in this._cacheProperties) {
                        if (typeof this[name] === typeof cache[name]) {
                            this[name] = cache[name];
                        }
                    }
                } catch (e) {
                    logWarning(`${this.name} cache: ${e.message}`, this.device.name);
                } finally {
                    resolve();
                }
            });
        });
    }

    /**
     * Write the plugin's cache to disk, synchronously
     */
    _writeCache() {
        try {
            let cache = this.cacheBuild();

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
     * Unregister plugin actions, write the cache (if applicable) and destroy
     * any dangling signal handlers.
     */
    destroy() {
        this._gactions.map(action => {
            this.device.menu.remove_action(`device.${action.name}`);
            this.device.remove_action(action.name);
        });

        // Write the cache to disk, if applicable
        if (this._cacheFile !== undefined) {
            this._writeCache();
        }

        // Try to avoid any cyclic references from signal handlers
        GObject.signal_handlers_destroy(this);
        GObject.signal_handlers_destroy(this.settings);
    }
});

