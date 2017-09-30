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

const { initTranslations, Me, DBusInfo, Settings } = imports.common;
const Config = imports.service.config;
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
        // TODO: error checking, re-test
        if (packet.body.hasOwnProperty("filename")) {
            let filepath = this.get_filepath(packet.body.filename);
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
    
    get_filepath: function (filename) {
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
        let dialog = new Dialog(this.device.daemon, this.device.name);
        
        if (dialog.run() === Gtk.ResponseType.OK) {
            let uris = dialog.get_uris();
            
            for (let uri of uris) {
                this.shareUri(uri.toString());
            }
            
            this._notifyShare(uris.length);
        }
        
        dialog.destroy();
    },
    
    _notifyShare: function (num) {
        // FIXME: this closes immediately after opening in the extension
        let note = new Notify.Notification({
            app_name: "GSConnect",
            summary: this.device.name,
            body: Gettext.ngettext("Sending %d file", "Sending %d files", num).format(num),
            icon_name: "send-to-symbolic"
        });
        
        note.show()
    },
    
    shareUri: function (uri) {
        if (this.device.connected && this.device.paired) {
            let packet = new Protocol.Packet();
            packet.type = "kdeconnect.share.request";
            
            if (uri.startsWith("file://")) {
                let file = Gio.File.new_for_uri(uri);
                let info = file.query_info("standard::size", 0, null);
                
                packet.body = { filename: file.get_basename() };
                packet.payloadSize = info.get_size();
                packet.payloadTransferInfo = { port: 1741 };
                
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
                packet.body = { url: uri };
            }
            
            this.device._channel.send(packet);
        }
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
    
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        this.add_button(_("Send"), Gtk.ResponseType.OK);
        this.set_default_response(Gtk.ResponseType.OK);
        this.connect("delete-event", application.vfunc_shutdown);
    }
});

