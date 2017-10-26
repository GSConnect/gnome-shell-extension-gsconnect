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


/**
 * Base class for plugins
 *
 * TODO: auto-call PropertiesChanged?
 *       make more "introspectable"?
 */
var Plugin = new Lang.Class({
    Name: "GSConnectPlugin",
    Extends: GObject.Object,
    
    _init: function (device, name) {
        this.parent();
        this.device = device;
        this.name = name;
        
        this.export_interface();
        
        if (this.device.config.plugins.hasOwnProperty(this.name)) {
            this.settings = this.device.config.plugins[this.name].settings;
        }
    },
    
    export_interface: function () {
        // Export DBus
        let iface = "org.gnome.Shell.Extensions.GSConnect." + this.name;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.Device.lookup_interface(iface),
            this
        );
        this._dbus.export(Gio.DBus.session, this.device._dbus.get_object_path());
    },
    
    handlePacket: function (packet) { throw Error("Not implemented"); },
    
    reconfigure: function () {},
    
    destroy: function () {
        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    },
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectPluginSettingsDialog",
    Extends: Gtk.Dialog,
    
    _init: function (devicePage, pluginName, window) {
        let metadata = imports.service.plugins[pluginName].METADATA;
        
        this.parent({
            title: metadata.summary,
            use_header_bar: true,
            transient_for: window,
            default_height: 320,
            default_width: 480
        });
        
        let headerBar = this.get_header_bar();
        headerBar.title = metadata.summary;
        headerBar.subtitle = metadata.description;
        headerBar.show_close_button = false;
        
        this.add_button(_("Apply"), Gtk.ResponseType.APPLY);
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        
        this._page = devicePage;
        this._name = pluginName;
        this.settings = this._page.config.plugins[this._name].settings;
        
        this.content = new PreferencesWidget.Page();
        this.content.box.margin_left = 36;
        this.content.box.margin_right = 36;
        this.get_content_area().add(this.content);
    }
});

