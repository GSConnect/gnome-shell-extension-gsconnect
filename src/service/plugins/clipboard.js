"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard",
    incomingCapabilities: ["kdeconnect.clipboard"],
    outgoingCapabilities: ["kdeconnect.clipboard"],
    actions: {
        provideClipboard: {
            summary: _("Provide Clipboard"),
            description: _("Provide clipboard update"),
            signature: "av",
            incoming: ["kdeconnect.clipboard"],
            outgoing: ["kdeconnect.clipboard"]
        }
    },
    events: {}
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
            this._clipboard.request_text((clipboard, text) => {
                if (!(this.allow & 2)) {
                    debug("Operation not permitted");
                    return;
                }

                this._provideContent(text);
            });
        });
    },

    handlePacket: function (packet) {
        debug(packet);

        return new Promise((resolve, reject) => {
            if (packet.body.content && (this.allow & 4)) {
                resolve(this._handleContent(packet.body.content));
            } else {
                reject(new Error("Operation not permitted: " + packet.type));
            }
        });
    },

    /**
     * Remote Methods
     */
    _handleContent: function (text) {
        debug(text);

        this._currentContent = text;
        this._clipboard.set_text(text, -1);
    },

    /**
     * Local Methods
     */
    _provideContent: function (text) {
        // FIXME
        if (text !== this._currentContent) {
            debug(text);

            this._currentContent = text;

            let packet = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.clipboard",
                body: { content: text }
            });

            this.send(packet);
        }
    },

    destroy: function () {
        GObject.signal_handlers_destroy(this._clipboard);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

