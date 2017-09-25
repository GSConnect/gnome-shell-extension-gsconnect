"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Notify = imports.gi.Notify;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Config = imports.service.config;
const Protocol = imports.service.protocol;
const { initTranslations, Me, DBusInfo, Settings } = imports.common;


/**
 * Base class for plugins
 *
 * TODO: common functions for export/unexport dbus
 *       auto-call PropertiesChanged?
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
    },
    
    export_interface: function () {
        // Export DBus
        let iface = "org.gnome.shell.extensions.gsconnect." + this.name;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            DBusInfo.device.lookup_interface(iface),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            "/org/gnome/shell/extensions/gsconnect/device/" + this.device.id
        );
    },
    
    handle_packet: function (packet) { throw Error("Not implemented"); },
    
    destroy: function () {
        this._dbus.unexport();
        delete this._dbus;
        // FIXME: signal handlers?
    },
});

