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
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Config = imports.service.config;
//const Prefs = imports.prefs;
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
    Properties: {
        "incomingPacket": GObject.param_spec_variant(
            "incomingPackets",
            "DevicesList", 
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "outgoingPackets": GObject.param_spec_variant(
            "outgoingPackets",
            "DevicesList", 
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    
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
    
    get incomingPackets() { throw Error("Not implemented"); },
    get outgoingPackets() { throw Error("Not implemented"); },
    
    handle_packet: function (packet) { throw Error("Not implemented"); },
    
    destroy: function () {
        this._dbus.unexport();
        delete this._dbus;
        // FIXME: signal handlers?
    },
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectSettingsDialog",
    Extends: Gtk.Dialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent({
            title: _("FIXME pluginInfo"),
            use_header_bar: true,
            transient_for: win,
            default_height: 200,
            default_width: 200
        });
        
        let headerBar = this.get_header_bar();
        headerBar.title = pluginInfo.summary;
        headerBar.subtitle = pluginInfo.description;
        headerBar.show_close_button = false;
        
        this.add_button(_("Apply"), Gtk.ResponseType.APPLY);
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        
        this._page = devicePage;
        this._name = pluginName;
        this._info = pluginInfo;
        this._settings = {};
        
        this.content = new PrefsPage({
            height_request: -1,
            valign: Gtk.Align.FILL,
            vexpand: true
        });
        this.content.box.margin_left = 40;
        this.content.box.margin_right = 40;
        this.get_content_area().add(this.content);
    }
});


/**
 * Plugin handlers, mapped to plugin names with default settings
 *
 * FIXME: this stuff should all be programmatic like KDE Connect
 */
var Metadata = new Map([
    ["battery", {
        settings: {
            threshold_notification: true,
            threshold_level: -2
        }
    }],
    ["ping", {
    }]
]);


