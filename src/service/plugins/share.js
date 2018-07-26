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
            summary: _('Share'),
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
            throw Error(_('Not supported for bluetooth connections'));
        }

        this.transfers = new Map();
    }

    /**
     * Get a GFile for @filename in ~/Downloads, with a numbered suffix if it
     * already exists (eg. `picture.jpg (1)`)
     *
     * @param {String} filename - The basename of the file
     * @return {Gio.File} - A new GFile for the given @filename in ~/Downloads
     */
    _getFile(filename) {
        let path = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
            filename
        ]);

        let filepath = path;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = `${path} (${copyNum})`;
        }

        return Gio.File.new_for_path(filepath);
    }

    async _handleFile(packet) {
        let file, success, transfer;
        let title, body, iconName;
        let buttons = [];

        try {
            file = this._getFile(packet.body.filename);

            transfer = new Lan.Transfer({
                device: this.device,
                output_stream: file.replace(null, false, Gio.FileCreateFlags.NONE, null),
                size: packet.payloadSize
            });

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Starting Transfer'),
                // TRANSLATORS: eg. Receiving 'book.pdf' from Google Pixel
                body: _('Receiving \'%s\' from %s').format(
                    packet.body.filename,
                    this.device.name
                ),
                // FIXME: cancelTransfer
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid)
                }],
                icon: new Gio.ThemedIcon({ name: 'send-to-symbolic' })
            });

            // Start transfer
            success = await transfer.download(packet.payloadTransferInfo.port);

            if (success) {
                title = _('Transfer Successful');
                // TRANSLATORS: eg. Received 'book.pdf' from Google Pixel
                body = _('Received \'%s\' from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                buttons = [
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
                ];
                iconName = 'send-to-symbolic';
            } else {
                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to receive 'book.pdf' from Google Pixel
                body = _('Failed to receive \'%s\' from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                iconName = 'dialog-warning-symbolic';

                // Clean up the downloaded file on failure
                file.delete(null);
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                buttons: buttons,
                icon: new Gio.ThemedIcon({ name: iconName })
            });
        } catch (e) {
            logWarning(e, this.device.name);
        }
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
    async shareFile(path) {
        debug(path);

        let file, transfer;

        try {
            if (path.startsWith('file://')) {
                file = Gio.File.new_for_uri(path);
            } else {
                file = Gio.File.new_for_path(path);
            }

            let info = file.query_info('standard::size', 0, null);

            if (this.device.connection_type === 'bluetooth') {
                transfer = new Bluetooth.Transfer({
                    device: this.device,
                    input_stream: file.read(null),
                    size: info.get_size()
                });
            } else if (this.device.connection_type === 'tcp') {
                transfer = new Lan.Transfer({
                    device: this.device,
                    input_stream: file.read(null),
                    size: info.get_size()
                });
            }

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Starting Transfer'),
                // TRANSLATORS: eg. Sending 'book.pdf' to Google Pixel
                body: _('Sending \'%s\' to %s').format(
                    file.get_basename(),
                    this.device.name
                ),
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid)
                }],
                icon: new Gio.ThemedIcon({ name: 'send-to-symbolic' })
            });

            let success = await transfer.upload({
                id: 0,
                type: 'kdeconnect.share.request',
                body: { filename: file.get_basename() }
            });

            let title, body, iconName;

            if (success) {
                title = _('Transfer Successful');
                // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                body = _('Sent "%s" to %s').format(
                    file.get_basename(),
                    this.device.name
                );
                iconName = 'send-to-symbolic';
            } else {
                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to send "book.pdf" to Google Pixel
                body = _('Failed to send "%s" to %s').format(
                    file.get_basename(),
                    this.device.name
                );
                iconName = 'dialog-warning-symbolic';
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                icon: new Gio.ThemedIcon({ name: iconName })
            });
        } catch (e) {
            logWarning(e, this.device.name);
        }
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
        this.connect('delete-event', () => this.response(Gtk.ResponseType.CANCEL));
    }

    _onUrlButtonToggled(button) {
        let header = this.get_header_bar();
        header.set_custom_title(button.active ? this._urlEntry : null);
    }

    _sendLink(widget) {
        if (this._urlButton.active && this._urlEntry.text.length) {
            this.response(1);
        }
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            let action = this.device.lookup_action('shareFile');
            let uris = this.get_uris();
            uris.map(uri => {
                let parameter = new GLib.Variant('s', uri.toString());
                this.device.activate_action('shareFile', parameter);
            });
        } else if (response_id === 1) {
            let parameter = new GLib.Variant('s', this._urlEntry.text);
            this.device.activate_action('shareUrl', parameter);
        }

        this.destroy();
    }

    // A non-blocking version of run()
    run() {
        this.show();
    }
});

