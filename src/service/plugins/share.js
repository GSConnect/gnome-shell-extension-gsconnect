"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Share",
    incomingCapabilities: ["kdeconnect.share.request"],
    outgoingCapabilities: ["kdeconnect.share.request"],
    actions: {
        shareDialog: {
            summary: _("Share Dialog"),
            description: _("Select a file or URL to share"),
            icon_name: "send-to-symbolic",

            signature: null,
            incoming: [],
            outgoing: ["kdeconnect.share.request"],
            allow: 2
        },
        shareFile: {
            summary: _("Share File"),
            description: _("Directly share a file"),
            signature: "av",
            incoming: [],
            outgoing: ["kdeconnect.share.request"],
            allow: 2
        },
        shareText: {
            summary: _("Share Text"),
            description: _("Directly share text"),
            signature: "av",
            incoming: [],
            outgoing: ["kdeconnect.share.request"],
            allow: 2
        },
        shareUrl: {
            summary: _("Share URL"),
            description: _("Directly share a Url"),
            signature: "av",
            incoming: [],
            outgoing: ["kdeconnect.share.request"],
            allow: 2
        }
    },
    events: {}
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving "text" TODO: Window with textview & "Copy to Clipboard..
 *       expand signals to cover Protocol.Transfer signals
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
var Plugin = new Lang.Class({
    Name: "GSConnectSharePlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "share");

        this.transfers = new Map();
    },

    /**
     * Local Methods
     */
    _getFilepath: function (filename) {
        debug(filename);

        let path = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
            filename
        ]);

        let filepath = path.toString(); // TODO: wtf
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = path + " (" + copyNum + ")";
        }

        return filepath;
    },

    _handleFile: function (packet) {
        let filepath = this._getFilepath(packet.body.filename);
        let file = Gio.File.new_for_path(filepath);

        let transfer = new Protocol.Transfer({
            device: this.device,
            output_stream: file.replace(null, false, Gio.FileCreateFlags.NONE, null),
            size: packet.payloadSize
        });

        transfer.connect("connected", (transfer) => {
            this.transfers.set(transfer.uuid, transfer);

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
                    transfer.uuid +
                    "'))"
                );

                this.device.send_notification(transfer.uuid, transfer.notif);
            });

            transfer.connect("succeeded", (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

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

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.event("receivedFile", file.get_uri());

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect("failed", (transfer, error) => {
                this.device.withdraw_notification(transfer.uuid);

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

                this.device.send_notification(transfer.uuid, transfer.notif);

                GLib.unlink(filepath);
                this.transfers.delete(transfer.uuid);
            });

            transfer.connect("cancelled", (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

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

                this.device.send_notification(transfer.uuid, transfer.notif);

                GLib.unlink(filepath);
                this.transfers.delete(transfer.uuid);
            });

            transfer.start();
        });

        transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
    },

    _handleUrl: function (packet) {
        Gio.AppInfo.launch_default_for_uri(packet.body.url, null);

        this.event("receivedUrl", packet.body.url);
    },

    _handleText: function (packet) {
        log("IMPLEMENT: " + packet.toString());
        log("receiving text: '" + packet.body.text + "'");

        this.event("receivedText", packet.body.text);
    },

    /**
     * Packet dispatch
     */
    handlePacket: function (packet) {
        debug("Share: handlePacket()");

        if (!(this.allow & 4)) {
            return
        } else if (packet.body.hasOwnProperty("filename")) {
            this._handleFile(packet);
        } else if (packet.body.hasOwnProperty("text")) {
            this._handleText(packet);
        } else if (packet.body.hasOwnProperty("url")) {
            this._handleUrl(packet);
        }
    },

    /**
     * Actions FIXME
     */
    _openFile: function (path) {
        Gio.AppInfo.launch_default_for_uri(path, null);
    },

    _openDirectory: function (path) {
        Gio.AppInfo.launch_default_for_uri(path, null);
    },

    /**
     * Remote methods
     */
    shareDialog: function () {
        // FIXME
        if (!(this.allow & 2)) {
            debug("Operation not permitted");
            return;
        }

        debug("opening FileChooserDialog");

        let dialog = new FileChooserDialog(this.device);
        dialog.run();
    },

    // TODO: check file existence...
    shareFile: function (path) {
        // FIXME
        if (!(this.allow & 2)) {
            debug("Operation not permitted");
            return;
        }

        debug(path);

        let file;

        // FIXME: error handling???
        try {
            if (path.startsWith("file://")) {
                file = Gio.File.new_for_uri(path);
            } else {
                file = Gio.File.new_for_path(path);
            }
        } catch (e) {
            return e;
        }

        let info = file.query_info("standard::size", 0, null);

        let transfer = new Protocol.Transfer({
            device: this.device,
            input_stream: file.read(null),
            size: info.get_size(),
            interactive: true
        });

        transfer.connect("connected", () => {
            transfer.start();
        });

        transfer.connect("connected", (transfer) => {
            this.transfers.set(transfer.uuid, transfer);

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
                    transfer.uuid +
                    "'))"
                );

                this.device.send_notification(transfer.uuid, transfer.notif);
            });

            transfer.connect("succeeded", (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_("Transfer Successful"));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                    _("Sent \"%s\" to %s").format(
                        file.get_basename(),
                        this.device.name
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: "send-to-symbolic" })
                );

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect("failed", (transfer, error) => {
                this.device.withdraw_notification(transfer.uuid);

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

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect("cancelled", (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

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

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.start();
        });

        // Start the transfer process
        transfer.upload().then(port => {
            this.device.sendPacket({
                id: 0,
                type: "kdeconnect.share.request",
                body: { filename: file.get_basename() },
                payloadSize: info.get_size(),
                payloadTransferInfo: { port: port }
            });
        });
    },

    shareText: function (text) {
        // FIXME
        if (!(this.allow & 2)) {
            debug("Operation not permitted");
            return;
        }

        debug(text);

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.share.request",
            body: { text: text }
        });
    },

    // TODO: check URL validity...
    shareUrl: function (url) {
        // FIXME
        if (!(this.allow & 2)) {
            debug("Operation not permitted");
            return;
        }

        debug(url);

        // Re-direct file:// uri's
        if (url.startsWith("file://")) {
            return this.sendFile(uri);
        // ...
        } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
        }

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.share.request",
            body: { url: uri }
        });
    }
});


/** A simple FileChooserDialog for sharing files */
var FileChooserDialog = new Lang.Class({
    Name: "GSConnectShareFileChooserDialog",
    Extends: Gtk.FileChooserDialog,

    _init: function (device) {
        this.parent({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _("Send files to %s").format(device.name),
            action: Gtk.FileChooserAction.OPEN,
            select_multiple: true,
            icon_name: "document-send"
        });
        this.device = device;

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
            tooltip_text: _("Send a link to %s").format(device.name),
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
    },

    // A non-blocking version of run()
    run: function () {
        this.connect("response", (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                let uris = this.get_uris();

                for (let uri of uris) {
                    this.device._plugins.get("share").shareFile(uri.toString());
                }
            } else if (response === 1) {
                this.device._plugins.get("share").shareUrl(this.webEntry.text);
            }

            this.destroy();
        });
        this.show();
    }
});

