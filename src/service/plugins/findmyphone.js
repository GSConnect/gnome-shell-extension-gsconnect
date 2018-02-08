"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);

const Sound = imports.modules.sound;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone",
    incomingPackets: ["kdeconnect.findmyphone.request"],
    outgoingPackets: ["kdeconnect.findmyphone.request"]
};


var UUID = "org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone";

var IncomingPacket = {
    LOCATE_EVENT: "kdeconnect.findmyphone.request"
};

var OutgoingPacket = {
    LOCATE_ACTION: "kdeconnect.findmyphone.request"
};

var Action = {
    find: {
        label: _("Locate the device"),
        incoming: [],
        outgoing: ["kdeconnect.findmyphone.request"]
    }
};


/**
 * FindMyPhone Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/findmyphone
 */
var Plugin = new Lang.Class({
    Name: "GSConnectFindMyPhonePlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "findmyphone");

        this._desktop = new Gio.Settings({
            schema_id: "org.gnome.system.location"
        });

        this._cancellable = null;
        this._dialog = null;
    },

    handlePacket: function (packet) {
        debug("FindMyPhone: handlePacket()");

        return new Promise((resolve, reject) => {
            if (this.allow & 4) {
                resolve(this._handleFind());
            } else {
                reject(new Error("Operation not permitted: " + packet.type));
            }
        });
    },

    /**
     * Local Methods
     */
    _handleFind: function () {
        debug("FindMyPhone: _ring()");

        if (this._cancellable || this._dialog) {
            this._endFind();
        }

        this._cancellable = new Gio.Cancellable();
        Sound.loopThemeSound("phone-incoming-call", this._cancellable);

        this._dialog = new Gtk.MessageDialog({
            text: _("Locate Device"),
            secondary_text: _("%s asked to locate this device").format(this.device.name),
            urgency_hint: true,
            window_position: Gtk.WindowPosition.CENTER_ALWAYS,
            application: this.device.daemon,
            skip_pager_hint: true,
            skip_taskbar_hint: true,
            visible: true
        });
        this._dialog.connect("delete-event", () => this._endFind());
        this._dialog.connect("key-press-event", (dialog, event) => {
            if (event.get_keyval()[1] === Gdk.KEY_Escape) {
                this._endFind();
            }
        });
        this._dialog.add_button(_("Found"), -4).connect("clicked", () => {
            this._endFind();
        });
        this._dialog.set_keep_above(true);
        this._dialog.present();

        return true;
    },

    _endFind: function () {
        this._cancellable.cancel();
        this._cancellable = null;
        this._dialog.destroy()
        this._dialog = null;
    },

    /**
     * Remote Methods
     */
    find: function () {
        debug(this.device.name);

        if (!(this.allow & 2)) {
            return new Error("Operation not permitted: " + packet.type);;
        }

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.findmyphone.request",
            body: {}
        });

        this.send(packet);
    },

    destroy: function () {
        if (this._cancellable || this._dialog) {
            this._endFind();
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

