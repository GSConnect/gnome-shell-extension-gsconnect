"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Clipboard"),
    description: _("Sync the clipboard between devices"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard",
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

        this._display = Gdk.Display.get_default();

        if (this._display === null) {
            this.destroy();
            throw Error(_("Failed to get Gdk.Display"));
        }

        this._clipboard = Gtk.Clipboard.get_default(this._display);

        if (this._clipboard === null) {
            this.destroy();
            throw Error(_("Failed to get Clipboard"));
        }

        this._clipboard.connect("owner-change", (clipboard, event) => {
            if (this.settings.get_boolean("send-content")) {
                this._clipboard.request_text(Lang.bind(this, this.send));
            }
        });
    },

    handlePacket: function (packet) {
        debug("Clipboard: handlePacket()");

        if (packet.body.content && this.settings.get_boolean("receive-content")) {
            this.receive(packet.body.content);
        }
    },

    receive: function (text) {
        debug("Clipboard: receive('" + text + "')");

        this._currentContent = text;
        this._clipboard.set_text(text, -1);
    },

    send: function (clipboard, text) {
        debug("Clipboard: send('" + text + "')");

        if (text !== this._currentContent) {
            this._currentContent = text;

            let packet = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.clipboard",
                body: { content: text }
            });

            this.device._channel.send(packet);
        }
    },

    destroy: function () {
        GObject.signal_handlers_destroy(this._clipboard);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectClipboardSettingsDialog",
    Extends: PluginsBase.SettingsDialog,

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let generalSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        generalSection.addGSetting(this.settings, "receive-content");
        generalSection.addGSetting(this.settings, "send-content");

        this.content.show_all();
    }
});

