"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
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
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "clipboard",
    incomingPackets: ["kdeconnect.clipboard"],
    outgoingPackets: ["kdeconnect.clipboard"]
};


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
var Plugin = new Lang.Class({
    Name: "GSConnectClipboardPlugin",
    Extends: PluginsBase.Plugin,
    
    _init: function (device) {
        this.parent(device, "clipboard");
        
        this._clipboard = Gtk.Clipboard.get_default(Gdk.Display.get_default());
        
        this._clipboard.connect("owner-change", () => {
            this._clipboard.request_text(Lang.bind(this, this.update));
        });
    },
    
    handlePacket: function (packet) {
        if (packet.body.hasOwnProperty("content")) {
            this._clipboard.set_text(packet.body.content, -1);
        }
    },
    
    update: function (clipboard, text) {
        let packet = new Protocol.Packet({
            id: Date.now(),
            type: "kdeconnect.clipboard",
            body: { content: text }
        });
        
        this.device._channel.send(packet);
    },
    
    destroy: function () {
        GObject.signal_handlers_destroy(this._clipboard);
    
        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

