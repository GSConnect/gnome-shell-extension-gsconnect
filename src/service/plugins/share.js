"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
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
    name: "share",
    summary: _("Share"),
    description: _("Send and receive files and URLs"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Share-Plugin",
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
 *
 * FIXME: transfer progress
 * TODO: receiving "text"
 *       expand signals to cover Protocol.Transfer signals
 *       emit signals (and export over DBus)
 */
var Plugin = new Lang.Class({
    Name: "GSConnectSharePlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "sent": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "share");
        
        this.transfers = new Map();
    },
    
    handlePacket: function (packet) {
        Common.debug("Share: handlePacket()");
        
        if (packet.body.hasOwnProperty("filename")) {
            let filepath = this.getFilepath(packet.body.filename);
            let file = Gio.File.new_for_path(filepath);
            
            let channel = new Protocol.LanDownloadChannel(
                this.device.daemon,
                this.device.identity,
                file.replace(null, false, Gio.FileCreateFlags.NONE, null)
            );
            
            channel.connect("connected", (channel) => {
                let transfer = new Protocol.Transfer(
                    channel._in,
                    channel._out,
                    packet.payloadSize
                );
                this.transfers.set(transfer.id, transfer);
                
                transfer.connect("started", (transfer) => {
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Starting Transfer"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Receiving "book.pdf" from Google Pixel
                        _("Receiving \"%s\" from %s").format(
                            packet.body.filename,
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
        
                    transfer.notif.add_button(
                        _("Cancel"),
                        "app.cancelTransfer(('" +
                        this._dbus.get_object_path() +
                        "','" +
                        transfer.id +
                        "'))"
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                });
                
                // TODO: progress updates happen so fast you can't click "cancel"
                transfer.connect("progress", (transfer, percent) => {
                    transfer.notif.set_title(_("Transfer In Progress"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Transfer of "book.pdf" from Google Pixel is 42% complete
                        _("Transfer of \"%s\" from %s is %d%% complete").format(
                            percent,
                            packet.body.filename,
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    //this.device.daemon.send_notification(
                    //    transfer.id,
                    //    transfer.notif
                    //);
                });
                
                transfer.connect("succeeded", (transfer) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Successful"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Received "book.pdf" from Google Pixel
                        _("Received \"%s\" from %s").format(
                            packet.body.filename,
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
        
                    transfer.notif.add_button(
                        _("Open Folder"),
                        "app.openTransfer('" +
                        escape(file.get_parent().get_uri()) +
                        "')"
                    );
        
                    transfer.notif.add_button(
                        _("Open File"),
                        "app.openTransfer('" +
                        escape(file.get_uri()) +
                        "')"
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.connect("failed", (transfer, error) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Failed"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Failed to receive "book.pdf" from Google Pixel: Some error
                        _("Failed to receive \"%s\" from %s: %s").format(
                            packet.body.filename,
                            this.device.name,
                            error
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    GLib.unlink(filepath);
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.connect("cancelled", (transfer) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Cancelled"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Cancelled transfer of "book.pdf" from Google Pixel
                        _("Cancelled transfer of \"%s\" from %s").format(
                            packet.body.filename,
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    GLib.unlink(filepath);
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.start();
            });
            
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.identity.body.tcpHost
                ),
                port: packet.payloadTransferInfo.port
            });
            
            channel.open(addr);
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
                this.device.name
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
        } else if (response === 1) {
            this.shareUri(dialog.webEntry.text);
        }
        
        dialog.destroy();
    },
    
    _shareOpen: function (filepath) {
        Gio.AppInfo.launch_default_for_uri(filepath, null);
    },
    
    _shareView: function (dirpath) {
        Gio.AppInfo.launch_default_for_uri(dirpath, null);
    },
    
    shareUri: function (uri) {
        Common.debug("Share: shareUri()");
        
        if (uri.startsWith("file://")) {
            let file = Gio.File.new_for_uri(uri);
            let info = file.query_info("standard::size", 0, null);
            
            let channel = new Protocol.LanUploadChannel(
                this.device.daemon,
                this.device.identity,
                file.read(null)
            );
            
            channel.connect("listening", (channel, port) => {
                let packet = new Protocol.Packet({
                    id: 0,
                    type: "kdeconnect.share.request",
                    body: { filename: file.get_basename() },
                    payloadSize: info.get_size(),
                    payloadTransferInfo: { port: port }
                });
                
                this.device._channel.send(packet);
            });
            
            channel.connect("connected", (channel) => {
                let transfer = new Protocol.Transfer(
                    channel._in,
                    channel._out,
                    info.get_size()
                );
                this.transfers.set(transfer.id, transfer);
                
                transfer.connect("started", (transfer) => {
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Starting Transfer"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Sending "book.pdf" to Google Pixel
                        _("Sending \"%s\" to %s").format(
                            file.get_basename(),
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
        
                    transfer.notif.add_button(
                        _("Cancel"),
                        "app.cancelTransfer(('" +
                        this._dbus.get_object_path() +
                        "','" +
                        transfer.id +
                        "'))"
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                });
                
                // TODO: progress updates happen so fast you can't click "cancel"
                transfer.connect("progress", (transfer, percent) => {
                    transfer.notif.set_title(_("Transfer In Progress"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Transfer of "book.pdf" to Google Pixel is 42% complete
                        _("Transfer of \"%s\" to %s is %d%% complete").format(
                            percent,
                            file.get_basename(),
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    //this.device.daemon.send_notification(
                    //    transfer.id,
                    //    transfer.notif
                    //);
                });
                
                transfer.connect("succeeded", (transfer) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Successful"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Send "book.pdf" to Google Pixel
                        _("Sent \"%s\" to %s").format(
                            file.get_basename(),
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.connect("failed", (transfer, error) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Failed"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Failed to send "book.pdf" to Google Pixel: Some error
                        _("Failed to send \"%s\" to %s: %s").format(
                            file.get_basename(),
                            this.device.name,
                            error
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.connect("cancelled", (transfer) => {
                    this.device.daemon.withdraw_notification(transfer.id);
                
                    transfer.notif = new Gio.Notification();
                    transfer.notif.set_title(_("Transfer Cancelled"));
                    transfer.notif.set_body(
                        // TRANSLATORS: eg. Cancelled transfer of "book.pdf" to Google Pixel
                        _("Cancelled transfer of \"%s\" to %s").format(
                            file.get_basename(),
                            this.device.name
                        )
                    );
                    transfer.notif.set_icon(
                        new Gio.ThemedIcon({ name: "send-to-symbolic" })
                    );
                    
                    this.device.daemon.send_notification(
                        transfer.id,
                        transfer.notif
                    );
                    
                    this.transfers.delete(transfer.id);
                    channel.close();
                });
                
                transfer.start();
            });
            
            channel.open();
        } else {
            if (!uri.startsWith("http://") && !uri.startsWith("https://")) {
                uri = "https://" + uri;
            }
            
            let packet = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.share.request",
                body: { url: uri }
            });
        
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
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _("Send files to %s").format(name),
            action: Gtk.FileChooserAction.OPEN,
            select_multiple: true,
            icon_name: "document-send"
        });
        
        this.webEntry = new Gtk.Entry({
            placeholder_text: "https://",
            hexpand: true,
            visible: true
        });
        this.webEntry.connect("activate", Lang.bind(this, this._sendLink));
        
        this.webButton = new Gtk.ToggleButton({
            image: Gtk.Image.new_from_icon_name(
                "web-browser-symbolic",
                Gtk.IconSize.BUTTON
            ),
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _("Send a link to %s").format(name),
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


var SettingsDialog = new Lang.Class({
    Name: "GSConnectShareSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let fbutton = new Gtk.FileChooserButton({
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        fbutton.set_current_folder(this.settings.download_directory);
        fbutton.connect("current-folder-changed", (button) => {
            this.settings.download_directory = fbutton.get_current_folder();
        });
        this.content.addItem(
            receivingSection,
            _("Download Location"),
            _("Directory to save received files"),
            fbutton
        );
        
        let subdirsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.download_subdirs
        });
        subdirsSwitch.connect("notify::active", (widget) => {
            this.settings.download_subdirs = subdirsSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Subdirectory"),
            // TRANSLATORS: eg. Save files in a subdirectory named Google Pixel
            _("Save files in a subdirectory named %s").format(this._page.device.name),
            subdirsSwitch
        );
        
        this.content.show_all();
    }
});

