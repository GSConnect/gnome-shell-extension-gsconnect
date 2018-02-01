"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const PreferencesWidget = imports.widgets.preferences;


var METADATA = {
    summary: _("Share"),
    description: _("Send and receive files and URLs"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Share",
    incomingPackets: ["kdeconnect.share.request"],
    outgoingPackets: ["kdeconnect.share.request"]
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving "text"
 *       expand signals to cover Protocol.Transfer signals
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
var Plugin = new Lang.Class({
    Name: "GSConnectSharePlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "sent": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING, GObject.TYPE_STRING ]
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING, GObject.TYPE_STRING ]
        }
    },

    _init: function (device) {
        this.parent(device, "share");

        if (!this.settings.get_string("download-directory")) {
            this.settings.set_string(
                "download-directory",
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD)
            );
        }

        this.transfers = new Map();
    },

    handlePacket: function (packet) {
        debug("Share: handlePacket()");

        if (packet.body.hasOwnProperty("filename")) {
            let filepath = this.getFilepath(packet.body.filename);
            let file = Gio.File.new_for_path(filepath);

            let channel = new Protocol.LanDownloadChannel(
                this.device.daemon,
                this.device.id,
                file.replace(null, false, Gio.FileCreateFlags.NONE, null)
            );

            channel.connect("connected", (channel) => {
                let transfer = new Protocol.Transfer(
                    channel,
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

                    this.device.send_notification(transfer.id, transfer.notif);
                });

                transfer.connect("succeeded", (transfer) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

                    this.emit("received", "file", file.get_uri());
                    this._dbus.emit_signal(
                        "received",
                        new GLib.Variant("(ss)", ["file", file.get_uri()])
                    );

                    this.transfers.delete(transfer.id);
                    channel.close();
                });

                transfer.connect("failed", (transfer, error) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

                    GLib.unlink(filepath);
                    this.transfers.delete(transfer.id);
                    channel.close();
                });

                transfer.connect("cancelled", (transfer) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

                    GLib.unlink(filepath);
                    this.transfers.delete(transfer.id);
                    channel.close();
                });

                transfer.start();
            });

            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.device.settings.get_string("tcp-host")
                ),
                port: packet.payloadTransferInfo.port
            });

            channel.open(addr);
        } else if (packet.body.hasOwnProperty("text")) {
            log("IMPLEMENT: " + packet.toString());
            log("receiving text: '" + packet.body.text + "'");

            this.emit("received", "text", packet.body.text);
            this._dbus.emit_signal(
                "received",
                new GLib.Variant("(ss)", ["text", packet.body.text])
            );
        } else if (packet.body.hasOwnProperty("url")) {
            Gio.AppInfo.launch_default_for_uri(packet.body.url, null);

            this.emit("received", "url", packet.body.url);
            this._dbus.emit_signal(
                "received",
                new GLib.Variant("(ss)", ["url", packet.body.url])
            );
        }
    },

    getFilepath: function (filename) {
        debug("Share: getFilepath(" + filename + ")");

        let path = this.settings.get_string("download-directory");

        if (this.settings.get_boolean("download-subdirectory")) {
            path = GLib.build_pathv("/", [path, this.device.name]);
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
        debug("Share: shareDialog()");

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
        debug("Share: shareUri()");

        if (uri.startsWith("file://")) {
            let file = Gio.File.new_for_uri(uri);
            let info = file.query_info("standard::size", 0, null);

            let channel = new Protocol.LanUploadChannel(
                this.device.daemon,
                this.device.id,
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
                    channel,
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

                    this.device.send_notification(transfer.id, transfer.notif);
                });

                transfer.connect("succeeded", (transfer) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

                    this.emit("sent", "file", file.get_basename());
                    this._dbus.emit_signal(
                        "sent",
                        new GLib.Variant("(ss)", ["file", file.get_basename()])
                    );

                    this.transfers.delete(transfer.id);
                    channel.close();
                });

                transfer.connect("failed", (transfer, error) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

                    this.transfers.delete(transfer.id);
                    channel.close();
                });

                transfer.connect("cancelled", (transfer) => {
                    this.device.withdraw_notification(transfer.id);

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

                    this.device.send_notification(transfer.id, transfer.notif);

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

            this.emit("sent", "url", uri);
            this._dbus.emit_signal(
                "sent",
                new GLib.Variant("(ss)", ["url", uri])
            );
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
            image: new Gtk.Image({
                icon_name: "web-browser-symbolic",
                pixel_size: 16
            }),
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

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let receivingSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );

        if (!this.settings.get_string("download-directory")) {
            this.settings.set_string(
                "download-directory",
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD)
            );
        }

        receivingSection.addGSetting(
            this.settings,
            "download-directory",
            PreferencesWidget.FolderSetting
        );

        receivingSection.addSetting(
            // TRANSLATORS: eg. Use a subdirectory named <b>Google Pixel<b>
            _("Use a subdirectory named <b>%s</b>").format(this.device.name),
            null,
            new PreferencesWidget.BoolSetting(
                this.settings,
                "download-subdirectory"
            )
        );

        this.content.show_all();
    }
});

