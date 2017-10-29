"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PreferencesWidget = imports.widgets.preferences;

const SCHEMA_PATH = "/org/gnome/shell/extensions/gsconnect/device/";


/**
 * Base class for plugins
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPlugin",
    Extends: GObject.Object,
    
    _init: function (device, name) {
        this.parent();
        
        this.device = device;
        let metadata = imports.service.plugins[name].METADATA;
        
        // Export DBus
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.GSConnect.lookup_interface(metadata.dbusInterface),
            this
        );
        this._dbus.export(Gio.DBus.session, device._dbus.get_object_path());
        
        // Init GSettings
        if (imports.service.plugins[name].SettingsDialog) {
            this.settings = new Gio.Settings({
                settings_schema: Common.SchemaSource.lookup(metadata.schemaId, -1),
                path: SCHEMA_PATH + device.id + "/plugin/" + name + "/"
            });
        }
    },
    
    handlePacket: function (packet) { throw Error("Not implemented"); },
    
    destroy: function () {
        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    },
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
            settings_schema: Common.SchemaSource.lookup(metadata.schemaId, -1),
            path: SCHEMA_PATH + device.id + "/plugin/" + name + "/"
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

