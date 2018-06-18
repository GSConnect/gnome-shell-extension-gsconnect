'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lan = imports.service.lan;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
    incomingCapabilities: ['kdeconnect.share.request'],
    outgoingCapabilities: ['kdeconnect.share.request'],
    actions: {
        shareDialog: {
            summary: _('Share Dialog'),
            description: _('Select a file or URL to share'),
            icon_name: 'send-to-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareFile: {
            summary: _('Share File'),
            description: _('Directly share a file'),
            icon_name: 'document-send-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareText: {
            summary: _('Share Text'),
            description: _('Directly share text'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareUrl: {
            summary: _('Share URL'),
            description: _('Directly share a Url'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        }
    }
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving 'text' TODO: Window with textview & 'Copy to Clipboard..
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSharePlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'share');

        if (this.device.connection_type === 'bluetooth') {
            this.destroy();
            throw Error(_('Can\'t run on bluetooth connection'));
        }

        this.transfers = new Map();
    }

    /**
     * Local Methods
     */
    _getFilepath(filename) {
        debug(filename);

        let path = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
            filename
        ]);

        let filepath = path.toString(); // TODO: wtf
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = path + ' (' + copyNum + ')';
        }

        return filepath;
    }

    _handleFile(packet) {
        let filepath = this._getFilepath(packet.body.filename);
        let file = Gio.File.new_for_path(filepath);

        let transfer = new Lan.Transfer({
            device: this.device,
            output_stream: file.replace(null, false, Gio.FileCreateFlags.NONE, null),
            size: packet.payloadSize
        });

        transfer.connect('connected', (transfer) => {
            this.transfers.set(transfer.uuid, transfer);

            transfer.connect('started', (transfer) => {
                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_('Starting Transfer'));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Receiving 'book.pdf' from Google Pixel
                    _('Receiving \'%s\' from %s').format(
                        packet.body.filename,
                        this.device.name
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                );

                transfer.notif.add_button(
                    _('Cancel'),
                    `app.cancelTransfer(('${this.device.object_path}','${transfer.uuid}'))`
                );

                this.device.send_notification(transfer.uuid, transfer.notif);
            });

            transfer.connect('succeeded', (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

                this.device.showNotification({
                    id: transfer.uuid,
                    title: _('Transfer Successful'),
                    // TRANSLATORS: eg. Received 'book.pdf' from Google Pixel
                    body: _('Received \'%s\' from %s').format(
                        packet.body.filename,
                        this.device.name
                    ),
                    icon: new Gio.ThemedIcon({ name: 'send-to-symbolic' }),
                    buttons: [
                        {
                            label: _('Open Folder'),
                            action: 'viewFolder',
                            parameter: new GLib.Variant('s', file.get_parent().get_uri())
                        },
                        {
                            label: _('Open File'),
                            action: 'viewFolder',
                            parameter: new GLib.Variant('s', file.get_uri())
                        }
                    ]
                });

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect('failed', (transfer, error) => {
                this.device.withdraw_notification(transfer.uuid);

                this.device.showNotification({
                    id: transfer.uuid,
                    title: _('Transfer Failed'),
                    // TRANSLATORS: eg. Failed to receive 'book.pdf' from Google Pixel: Some error
                    body: _('Failed to receive \'%s\' from %s: %s').format(
                        packet.body.filename,
                        this.device.name,
                        error
                    ),
                    icon: new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                });

                GLib.unlink(filepath);
                this.transfers.delete(transfer.uuid);
            });

            transfer.connect('cancelled', (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

                this.device.showNotification({
                    id: transfer.uuid,
                    title: _('Transfer Cancelled'),
                    // TRANSLATORS: eg. Cancelled transfer of 'book.pdf' from Google Pixel
                    body: _('Cancelled transfer of \'%s\' from %s').format(
                        packet.body.filename,
                        this.device.name
                    ),
                    icon: new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                });

                GLib.unlink(filepath);
                this.transfers.delete(transfer.uuid);
            });

            transfer.start();
        });

        transfer.download(packet.payloadTransferInfo.port).catch(e => debug(e));
    }

    _handleUrl(packet) {
        Gio.AppInfo.launch_default_for_uri(packet.body.url, null);
    }

    _handleText(packet) {
        log(`receiving text: "${packet.body.text}"`);
    }

    /**
     * Packet dispatch
     */
    handlePacket(packet) {
        debug('Share: handlePacket()');

        if (packet.body.hasOwnProperty('filename')) {
            this._handleFile(packet);
        } else if (packet.body.hasOwnProperty('text')) {
            this._handleText(packet);
        } else if (packet.body.hasOwnProperty('url')) {
            this._handleUrl(packet);
        }
    }

    /**
     * Remote methods
     */
    shareDialog() {
        debug('opening FileChooserDialog');

        let dialog = new FileChooserDialog(this.device);
        dialog.run();
    }

    // TODO: check file existence...
    shareFile(path) {
        debug(path);

        let file;

        // FIXME: error handling???
        try {
            if (path.startsWith('file://')) {
                file = Gio.File.new_for_uri(path);
            } else {
                file = Gio.File.new_for_path(path);
            }
        } catch (e) {
            return e;
        }

        let info = file.query_info('standard::size', 0, null);
        let transfer;

        if (this.device.connection_type === 'bluetooth') {
        } else if (this.device.connection_type === 'tcp') {
            transfer = new Lan.Transfer({
                device: this.device,
                input_stream: file.read(null),
                size: info.get_size(),
                interactive: true
            });
        }

        transfer.connect('connected', (transfer) => {
            this.transfers.set(transfer.uuid, transfer);

            transfer.connect('started', (transfer) => {
                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_('Starting Transfer'));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Sending 'book.pdf' to Google Pixel
                    _('Sending \'%s\' to %s').format(
                        file.get_basename(),
                        this.device.name
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                );

                // FIXME
                transfer.notif.add_button(
                    _('Cancel'),
                    `app.cancelTransfer(('${this.device.object_path}','${transfer.uuid}'))`
                );

                this.device.send_notification(transfer.uuid, transfer.notif);
            });

            transfer.connect('succeeded', (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_('Transfer Successful'));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Sent 'book.pdf' to Google Pixel
                    _('Sent \'%s\' to %s').format(
                        file.get_basename(),
                        this.device.name
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                );

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect('failed', (transfer, error) => {
                this.device.withdraw_notification(transfer.uuid);

                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_('Transfer Failed'));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Failed to send 'book.pdf' to Google Pixel: Some error
                    _('Failed to send \'%s\' to %s: %s').format(
                        file.get_basename(),
                        this.device.name,
                        error
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                );

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.connect('cancelled', (transfer) => {
                this.device.withdraw_notification(transfer.uuid);

                transfer.notif = new Gio.Notification();
                transfer.notif.set_title(_('Transfer Cancelled'));
                transfer.notif.set_body(
                    // TRANSLATORS: eg. Cancelled transfer of 'book.pdf' to Google Pixel
                    _('Cancelled transfer of \'%s\' to %s').format(
                        file.get_basename(),
                        this.device.name
                    )
                );
                transfer.notif.set_icon(
                    new Gio.ThemedIcon({ name: 'send-to-symbolic' })
                );

                this.device.send_notification(transfer.uuid, transfer.notif);

                this.transfers.delete(transfer.uuid);
            });

            transfer.start();
        });

        // Start the transfer process
        transfer.upload().then(transferChannel => {
            let transferInfo = {};

            if (this.device.connection_type === 'bluetooth') {
                transferInfo.uuid = transferChannel;
            } else if (this.device.connection_type === 'tcp') {
                transferInfo.port = transferChannel;
            }

            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.share.request',
                body: { filename: file.get_basename() },
                payloadSize: info.get_size(),
                payloadTransferInfo: transferInfo
            });
        });
    }

    shareText(text) {
        debug(text);

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.share.request',
            body: { text: text }
        });
    }

    // TODO: check URL validity...
    shareUrl(url) {
        debug(url);

        // Re-direct file:// uri's
        if (url.startsWith('file://')) {
            return this.sendFile(url);
        // ...
        } else if (!url.startsWith('http://') &&
                   !url.startsWith('https://') &&
                   !url.startsWith('tel:')) {
            url = 'https://' + url;
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.share.request',
            body: { url: url }
        });
    }
});


/** A simple FileChooserDialog for sharing files */
var FileChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectShareFileChooserDialog',
}, class FileChooserDialog extends Gtk.FileChooserDialog {

    _init(device) {
        super._init({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(device.name),
            action: Gtk.FileChooserAction.OPEN,
            select_multiple: true,
            icon_name: 'document-send'
        });
        this.device = device;

        this._urlEntry = new Gtk.Entry({
            placeholder_text: 'https://',
            hexpand: true,
            visible: true
        });
        this._urlEntry.connect('activate', this._sendLink.bind(this));

        this._urlButton = new Gtk.ToggleButton({
            image: new Gtk.Image({
                icon_name: 'web-browser-symbolic',
                pixel_size: 16
            }),
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _('Send a link to %s').format(device.name),
            visible: true
        });
        this._urlButton.connect('toggled', this._onUrlButtonToggled.bind(this));

        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        let sendButton = this.add_button(_('Send'), Gtk.ResponseType.OK);
        sendButton.connect('clicked', this._sendLink.bind(this));

        this.get_header_bar().pack_end(this._urlButton);
        this.set_default_response(Gtk.ResponseType.OK);
        this.connect('delete-event', () => {
            this.emit('response', Gtk.ResponseType.CANCEL);
        });
    }

    _onUrlButtonToggled(button) {
        let header = this.get_header_bar();
        header.set_custom_title(button.active ? this._urlEntry : null);
    }

    _sendLink(widget) {
        if (this._urlButton.active && this._urlEntry.text.length) {
            this.emit('response', 1);
        }
    }

    // A non-blocking version of run()
    run() {
        this.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                let action = this.device.lookup_action('shareFile');
                let uris = this.get_uris();
                uris.map(uri => {
                    let parameter = new GLib.Variant('s', uri.toString());
                    this.device.activate_action('shareFile', parameter);
                });
            } else if (response === 1) {
                let parameter = new GLib.Variant('s', this._urlEntry.text);
                this.device.activate_action('shareUrl', parameter);
            }

            dialog.destroy();
        });
        this.show();
    }
});

