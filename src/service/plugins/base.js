"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PreferencesWidget = imports.widgets.preferences;


/**
 * Base class for plugins
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPlugin",
    Extends: GObject.Object,

    _init: function (device, name) {
        this.parent();

        this.device = device;
        this.name = name;
        let metadata = imports.service.plugins[name].METADATA;

        // Export DBus
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            ext.dbusinfo.lookup_interface(metadata.uuid),
            this
        );
        this._dbus.export(Gio.DBus.session, device._dbus.get_object_path());

        // Init GSettings
        if (imports.service.plugins[name].SettingsDialog) {
            this.settings = new Gio.Settings({
                settings_schema: ext.gschema.lookup(metadata.uuid, -1),
                path: ext.settings.path + "device/" + device.id + "/plugin/" + name + "/"
            });
        }
    },

    handlePacket: function (packet) { throw Error("Not implemented"); },

    /**
     * Cache JSON parseable properties on this object for persistence. The
     * filename ~/.cache/gsconnect/<plugin>/<device-id>.json will be used to
     * store the properties and values.
     *
     * Calling initPersistence() opens a JSON cache file and reads any
     * existing properties and values onto the current instance. When destroy()
     * is called the properties are automatically stored in the same file.
     *
     * @param {array} names - A list of this object's property names to cache
     */
    initPersistence: function (names) {
        this._cacheDir =  GLib.build_filenamev([ext.cachedir, this.name]);
        GLib.mkdir_with_parents(this._cacheDir, 448);

        this._cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._cacheDir, this.device.id + ".json"])
        );

        this._cacheProperties = {};

        for (let name of names) {
            if (this.hasOwnProperty(name)) {
                this._cacheProperties[name] = typeof this[name];
            }
        }

        this._readCache();
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
        if (this._cacheFile) {
            this._writeCache();
        }

        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    }
});


/**
 * Base class for plugin settings dialogs
 */
var SettingsDialog = new Lang.Class({
    Name: "GSConnectPluginSettingsDialog",
    Extends: Gtk.Dialog,

    _init: function (device, name, window) {
        this.parent({
            use_header_bar: true,
            transient_for: window,
            default_height: 320,
            default_width: 480
        });

        this.device = device;
        let metadata = imports.service.plugins[name].METADATA;

        this.settings = new Gio.Settings({
            settings_schema: ext.gschema.lookup(metadata.uuid, -1),
            path: ext.settings.path + "device/" + device.id + "/plugin/" + name + "/"
        });
        this.settings.delay();

        let headerBar = this.get_header_bar();
        headerBar.title = metadata.summary;
        headerBar.subtitle = metadata.description;
        headerBar.show_close_button = false;

        this.add_button(_("Apply"), Gtk.ResponseType.APPLY);
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.APPLY);

        this.content = new PreferencesWidget.Page();
        this.content.box.margin_left = 36;
        this.content.box.margin_right = 36;
        this.get_content_area().add(this.content);
    }
});

