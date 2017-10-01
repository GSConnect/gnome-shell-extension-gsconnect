"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

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
        let iface = "org.gnome.shell.extensions.gsconnect." + this.name;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            Common.DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    handlePacket: function (packet) { throw Error("Not implemented"); },
    
    reconfigure: function () {},
    
    destroy: function () {
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    },
});

