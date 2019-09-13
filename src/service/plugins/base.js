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

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this._meta.id, false),
            path: `${device.settings.path}plugin/${name}/`
        });

        // GActions
        this._gactions = [];

        if (this._meta.actions) {
            let menu = this.device.settings.get_strv('menu-actions');

            for (let name in this._meta.actions) {
                let meta = this._meta.actions[name];
                this._registerAction(name, menu.indexOf(name), meta);
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

    _activateAction(action, parameter = null) {
        try {
            if (parameter instanceof GLib.Variant) {
                parameter = parameter.full_unpack();
            }

            if (Array.isArray(parameter)) {
                this[action.name].apply(this, parameter);
            } else {
                this[action.name].call(this, parameter);
            }
        } catch (e) {
            logError(e, action.name);
        }
    }

    _registerAction(name, menuIndex, meta) {
        try {
            // Device Action
            let action = new Gio.SimpleAction({
                name: name,
                parameter_type: meta.parameter_type,
                enabled: false
            });
            action.connect('activate', this._activateAction.bind(this));

            this.device.add_action(action);

            // Menu
            if (menuIndex > -1) {
                this.device.addMenuAction(
                    action,
                    menuIndex,
                    meta.label,
                    meta.icon_name
                );
            }

            this._gactions.push(action);
        } catch (e) {
            logError(e, `${this.device.name}: ${this.name}`);
        }
    }

    /**
     * This is called when a packet is received the plugin is a handler for
     *
     * @param {object} packet - A KDE Connect packet
     */
    handlePacket(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * These two methods are called by the device in response to the connection
     * state changing.
     */
    connected() {
        // Enabled based on device capabilities, which might change
        let incoming = this.device.settings.get_strv('incoming-capabilities');
        let outgoing = this.device.settings.get_strv('outgoing-capabilities');

        for (let action of this._gactions) {
            let meta = this._meta.actions[action.name];

            if (meta.incoming.every(type => outgoing.includes(type)) &&
                meta.outgoing.every(type => incoming.includes(type))) {
                action.set_enabled(true);
            }
        }
    }

    disconnected() {
        for (let action of this._gactions) {
            action.set_enabled(false);
        }
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
                gsconnect.cachedir,
                this.device.id
            ]);
            GLib.mkdir_with_parents(cachedir, 448);

            this.__cache_file = Gio.File.new_for_path(
                GLib.build_filenamev([cachedir, `${this.name}.json`])
            );

            // Read the cache from disk
            let cache = await JSON.load(this.__cache_file);
            Object.assign(this, cache);
        } catch (e) {
            debug(e.message, `${this.device.name}: ${this.name}`);
        } finally {
            this.cacheLoaded();
        }
    }

    /**
     * An overridable function that is invoked when the cache is done loading
     */
    cacheLoaded() {}

    /**
     * Write the plugin's cache to disk
     */
    async __cache_write() {
        if (this.__cache_lock) {
            this.__cache_queue = true;
            return;
        }

        try {
            this.__cache_lock = true;

            // Build the cache
            let cache = {};

            for (let name of this.__cache_properties) {
                cache[name] = this[name];
            }

            await JSON.dump(cache, this.__cache_file);
        } catch (e) {
            debug(e.message, `${this.device.name}: ${this.name}`);
        } finally {
            this.__cache_lock = false;

            if (this.__cache_queue) {
                this.__cache_queue = false;
                this.__cache_write();
            }
        }
    }

    /**
     * Unregister plugin actions, write the cache (if applicable) and destroy
     * any dangling signal handlers.
     */
    destroy() {
        for (let action of this._gactions) {
            this.device.removeMenuAction(`device.${action.name}`);
            this.device.remove_action(action.name);
            action.run_dispose();
        }

        // Write the cache to disk synchronously
        if (this.__cache_file && !this.__cache_lock) {
            try {
                // Build the cache
                let cache = {};

                for (let name of this.__cache_properties) {
                    cache[name] = this[name];
                }

                JSON.dump(cache, this.__cache_file, true);
            } catch (e) {
                debug(e.message, `${this.device.name}: ${this.name}`);
            }
        }

        // Try to avoid any cyclic references from signal handlers
        this.settings.run_dispose();
        this.run_dispose();
    }
});

