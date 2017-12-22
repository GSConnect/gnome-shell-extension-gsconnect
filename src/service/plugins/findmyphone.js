"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Sound = imports.sound;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Locate Device"),
    description: _("Find a device by making it ring"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.FindMyPhone",
    incomingPackets: ["kdeconnect.findmyphone.request"],
    outgoingPackets: ["kdeconnect.findmyphone.request"]
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

        this._cancellable = null;
        this._dialog = null;
    },

    _ring: function () {
        debug("FindMyPhone: _ring()");

        if (this._cancellable || this._dialog) {
            this._closeDialog();
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
            skip_taskbar_hint: true
        });
        this._dialog.connect("delete-event", () => { this._closeDialog(); });
        this._dialog.connect("key-press-event", (dialog, event, user_data) => {
            if (event.get_keyval()[1] === Gdk.KEY_Escape) {
                this._closeDialog();
            }
        });
        this._dialog.add_button(_("Found"), -4).connect("clicked", () => {
            this._closeDialog();
        });
        this._dialog.set_keep_above(true);
        this._dialog.show();
        this._dialog.present();
    },

    _closeDialog: function () {
        this._cancellable.cancel();
        this._cancellable = null;
        this._dialog.destroy()
        this._dialog = null;
    },

    handlePacket: function (packet) {
        debug("FindMyPhone: handlePacket()");

        this._ring();
    },

    find: function () {
        debug("FindMyPhone: ring()");

        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.findmyphone.request",
                body: {}
            });

            this.device._channel.send(packet);
        }
    },

    destroy: function () {
        if (this._cancellable || this._dialog) {
            this._closeDialog();
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

