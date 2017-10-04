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
    summary: _("Share"),
    description: _("Send and receive files and URLs"),
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
            
            let channel = new Protocol.LanDownloadChannel(
                this.device,
                packet.payloadTransferInfo.port,
                file.replace(null, false, Gio.FileCreateFlags.NONE, null)
            );
            
            channel.connect("connected", (channel) => {
                let transfer = new Protocol.Transfer(
                    channel._in,
                    channel._out,
                    packet.payloadSize
                );
                
                transfer.connect("started", (transfer) => {
                    transfer.notif = new Notify.Notification({
                        app_name: _("GSConnect"),
                        summary: _("Starting transfer"),
                        body: _("Receiving %s from %s").format(
                            packet.body.filename,
                            this.device.name
                        ),
                        icon_name: "send-to-symbolic"
                    });
                    
                    transfer.notif.set_category("transfer");
        
                    transfer.notif.add_action(
                        "share_cancel",
                        _("Cancel"),
                        Lang.bind(transfer, transfer.cancel)
                    );
                    
                    transfer.notif.connect("closed", (notification) => {
                        delete transfer.notif;
                    });
                    
                    transfer.notif.show();
                });
                
                // TODO: progress updates happen so fast you can't click "cancel"
                transfer.connect("progress", (transfer, percent) => {
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            _("Receiving %s from %s").format(
                                packet.body.filename,
                                this.device.name
                            ),
                            _("Transfer is %d%% complete").format(percent),
                            "send-to-symbolic"
                        );
                        //transfer.notif.show();
                    }
                });
                
                transfer.connect("succeeded", (transfer) => {
                    let summary = _("Transfer successful");
                    let body = _("Received %s from %s").format(
                        packet.body.filename,
                        this.device.name
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    // TODO: view/open file
                    
                    transfer.notif.show();
                    channel.close();
                });
                
                transfer.connect("failed", (transfer, error) => {
                    let summary = _("Transfer failed");
                    let body = _("Failed to receive %s from %s: %s").format(
                        file.get_basename(),
                        this.device.name, error
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    // TODO: remove file
                    
                    transfer.notif.show();
                    channel.close();
                });
                
                transfer.connect("cancelled", (transfer) => {
                    let summary = _("Transfer cancelled");
                    let body = _("Cancelled receiving %s from %s").format(
                        packet.body.filename,
                        this.device.name
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    // TODO: remove file
                    
                    transfer.notif.show();
                    channel.close();
                });
                
                transfer.start();
            });
            
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
                this.device,
                1739,
                file.read(null)
            );
            
            channel.connect("listening", (channel) => {
                let packet = new Protocol.Packet({
                    id: 0,
                    type: "kdeconnect.share.request",
                    body: { filename: file.get_basename() }
                });
                
                packet.payloadSize = info.get_size();
                packet.payloadTransferInfo = { port: channel._port };
                
                this.device._channel.send(packet);
            });
            
            channel.connect("connected", (channel) => {
                let transfer = new Protocol.Transfer(
                    channel._in,
                    channel._out,
                    info.get_size()
                );
                
                transfer.connect("started", (transfer) => {
                    transfer.notif = new Notify.Notification({
                        app_name: _("GSConnect"),
                        summary: _("Starting transfer"),
                        body: _("Sending %s to %s").format(
                            file.get_basename(),
                            this.device.name
                        ),
                        icon_name: "send-to-symbolic"
                    });
                    
                    transfer.notif.set_category("transfer");
        
                    transfer.notif.add_action(
                        "share_cancel",
                        _("Cancel"),
                        Lang.bind(transfer, transfer.cancel)
                    );
                    
                    transfer.notif.connect("closed", (notification) => {
                        delete transfer.notif;
                    });
                    
                    transfer.notif.show();
                });
                
                // TODO: progress updates happen so fast you can't click "cancel"
                transfer.connect("progress", (transfer, percent) => {
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            _("Sending %s to %s").format(
                                file.get_basename(),
                                this.device.name
                            ),
                            _("Transfer is %d%% complete").format(percent),
                            "send-to-symbolic"
                        );
                        //transfer.notif.show();
                    }
                });
                
                transfer.connect("succeeded", (transfer) => {
                    let summary = _("Transfer successful");
                    let body = _("Sent %s to %s").format(
                        file.get_basename(),
                        this.device.name
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    transfer.notif.show();
                    channel.close();
                });
                
                transfer.connect("failed", (transfer, error) => {
                    let summary = _("Transfer failed");
                    let body = _("Failed to send %s to %s: %s").format(
                        file.get_basename(),
                        this.device.name, error
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    transfer.notif.show();
                    channel.close();
                });
                
                transfer.connect("cancelled", (transfer) => {
                    let summary = _("Transfer cancelled");
                    let body = _("Cancelled sending %s to %s").format(
                        file.get_basename(),
                        this.device.name
                    );
                    
                    if (transfer.hasOwnProperty("notif")) {
                        transfer.notif.update(
                            summary,
                            body,
                            "send-to-symbolic"
                        );
                    } else {
                        transfer.notif = new Notify.Notification({
                            app_name: _("GSConnect"),
                            summary: summary,
                            body: body,
                            icon_name: "send-to-symbolic"
                        });
                    }
                    
                    transfer.notif.show();
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


var SettingsDialog = new Lang.Class({
    Name: "GSConnectShareSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let fbutton = new Gtk.FileChooserButton({
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        fbutton.set_current_folder(this._settings.download_directory);
        fbutton.connect("current-folder-changed", (button) => {
            this._settings.download_directory = fbutton.get_current_folder();
        });
        this.content.addItem(
            receivingSection,
            _("Download location"),
            _("Choose a location to save received files"),
            fbutton
        );
        
        let subdirsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.download_subdirs
        });
        subdirsSwitch.connect("notify::active", (widget) => {
            this._settings.download_subdirs = subdirsSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Subdirectories"),
            _("Save files in device subdirectories"),
            subdirsSwitch
        );
        
        this.content.show_all();
    }
});

