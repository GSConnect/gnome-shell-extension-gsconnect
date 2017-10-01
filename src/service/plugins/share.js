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

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "share",
    incomingPackets: ["kdeconnect.share.request"],
    outgoingPackets: ["kdeconnect.share.request"],
    settings: {
        download_directory: GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_DOWNLOAD
        ),
        download_subdirs: false
    }
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 */
var Plugin = new Lang.Class({
    Name: "GSConnectSharePlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "share": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    MIN_PORT: 1739,
    MAX_PORT: 1764,
    
    _init: function (device) {
        this.parent(device, "share");
    },
    
    // TODO: error checking
    //       re-test
    //       notify?
    handlePacket: function (packet) {
        Common.debug("Share: handlePacket()");
        
        // TODO: error checking, re-test
        if (packet.body.hasOwnProperty("filename")) {
            let filepath = this.getFilepath(packet.body.filename);
            let file = Gio.File.new_for_path(filepath);
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.identity.body.tcpHost
                ),
                port: packet.payloadTransferInfo.port
            });
            
            let channel = new Protocol.LanDownloadChannel(
                this.device,
                addr,
                file.replace(null, false, Gio.FileCreateFlags.NONE, null),
                packet.payloadSize
            );
            
            channel.open();
        } else if (packet.body.hasOwnProperty("text")) {
            log("IMPLEMENT: " + packet.toString());
            log("receiving text: '" + packet.body.text + "'");
        } else if (packet.body.hasOwnProperty("url")) {
            Gio.AppInfo.launch_default_for_uri(packet.body.url, null);
        }
    },
    
    getFilepath: function (filename) {
        Common.debug("Share: getFilepath(" + filename + ")");
        
        let path = this.settings.download_directory
        
        if (this.settings.download_subdirs) {
            path = GLib.build_pathv("/", [
                this.settings.download_directory,
                this.device.id
            ]);
        }
        
        if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(path, 493);
        }
        
        path = GLib.build_filenamev([path, filename]);
        
        let filepath = path.toString();
        let copyNum = 0;
        
        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = path + " (" + copyNum + ")";
        }
        
        return filepath;
    },
    
    shareDialog: function () {
        Common.debug("Share: shareDialog()");
        
        let dialog = new Dialog(this.device.daemon, this.device.name);
        let response = dialog.run()
        
        if (response === Gtk.ResponseType.OK) {
            let uris = dialog.get_uris();
            
            for (let uri of uris) {
                this.shareUri(uri.toString());
            }
            
            this._notifyShare(uris.length);
        } else if (response === 1) {
            this.shareUri(dialog.webEntry.text);
        }
        
        dialog.destroy();
    },
    
    _notifyShare: function (num) {
        Common.debug("Share: _notifyShare()");
        
        let note = new Notify.Notification({
            app_name: "GSConnect",
            summary: this.device.name,
            body: Gettext.ngettext("Sending %d file", "Sending %d files", num).format(num),
            icon_name: "send-to-symbolic"
        });
        
        note.show()
    },
    
    shareUri: function (uri) {
        Common.debug("Share: shareUri()");
        
        let packet = new Protocol.Packet();
        packet.type = "kdeconnect.share.request";
        
        if (uri.startsWith("file://")) {
            let file = Gio.File.new_for_uri(uri);
            let info = file.query_info("standard::size", 0, null);
            
            packet.body = { filename: file.get_basename() };
            packet.payloadSize = info.get_size();
            packet.payloadTransferInfo = { port: 1741 }; // FIXME
            
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: packet.payloadTransferInfo.port
            });
            
            let channel = new Protocol.LanUploadChannel(
                this.device,
                addr,
                file.read(null),
                packet.payloadSize
            );
            
            channel.open();
        } else {
            if (!uri.startsWith("http://") && !uri.startsWith("https://")) {
                uri = "https://" + uri;
            }
            
            packet.body = { url: uri };
        }
        
        this.device._channel.send(packet);
    }
});


/** A simple FileChooserDialog for sharing files */
var Dialog = new Lang.Class({
    Name: "ShareDialog",
    Extends: Gtk.FileChooserDialog,
    
    _init: function (application, name) {
        this.parent({
            title: _("Send files to %s").format(name),
            action: Gtk.FileChooserAction.OPEN,
            select_multiple: true,
            icon_name: "document-send"
        });
        
        this.webEntry = new Gtk.Entry({
            placeholder_text: _("Enter link address"),
            hexpand: true,
            visible: true
        });
        this.webEntry.connect("activate", Lang.bind(this, this._sendLink));
        
        this.webButton = new Gtk.ToggleButton({
            image: Gtk.Image.new_from_icon_name(
                "web-browser-symbolic",
                Gtk.IconSize.BUTTON
            ),
            // FIXME: better tooltip
            tooltip_text: _("Send a link (should start with 'http://' or 'https://)"),
            visible: true
        });
        this.webButton.connect("toggled", () => {
            if (this.webButton.active) {
                this.get_header_bar().set_custom_title(this.webEntry);
            } else {
                this.get_header_bar().set_custom_title(null);
            }
        });
    
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        let sendButton = this.add_button(_("Send"), Gtk.ResponseType.OK);
        sendButton.connect("clicked", Lang.bind(this, this._sendLink));
        
        
        this.get_header_bar().pack_end(this.webButton);
        this.set_default_response(Gtk.ResponseType.OK);
        this.connect("delete-event", () => {
            this.emit("response", Gtk.ResponseType.CANCEL);
        });
    },
    
    _sendLink: function (widget) {
        if (this.webButton.active && this.webEntry.text.length) {
            this.emit("response", 1);
        }
    }
});

