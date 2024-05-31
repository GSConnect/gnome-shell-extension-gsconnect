// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import Plugin from '../plugin.js';
import * as URI from '../utils/uri.js';


export const Metadata = {
    label: _('Share'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
    description: _('Share files and URLs between devices'),
    incomingCapabilities: ['kdeconnect.share.request'],
    outgoingCapabilities: [
        'kdeconnect.share.request',
        'kdeconnect.share.request.update',
    ],
    actions: {
        share: {
            label: _('Share'),
            icon_name: 'send-to-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareFile: {
            label: _('Share File'),
            icon_name: 'document-send-symbolic',

            parameter_type: new GLib.VariantType('(sb)'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareFiles: {
            label: _('Share Files'),
            icon_name: 'document-send-symbolic',

            parameter_type: new GLib.VariantType('(asb)'),
            incoming: [],
            outgoing: [
                'kdeconnect.share.request',
                'kdeconnect.share.request.update',
            ],
        },
        shareFilesWithTemps: {
            label: _('Share Files (including temporaries)'),

            parameter_type: new GLib.VariantType('(asas)'),
            incoming: [],
            outgoing: [
                'kdeconnect.share.request',
                'kdeconnect.share.request.update',
            ],
        },
        shareText: {
            label: _('Share Text'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareUri: {
            label: _('Share Link'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
    },
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving 'text' TODO: Window with textview & 'Copy to Clipboard..
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
const SharePlugin = GObject.registerClass({
    GTypeName: 'GSConnectSharePlugin',
}, class SharePlugin extends Plugin {

    _init(device) {
        super._init(device, 'share');
    }

    handlePacket(packet) {
        // TODO: composite jobs (lastModified, numberOfFiles, totalPayloadSize)
        if (packet.body.hasOwnProperty('filename')) {
            if (this.settings.get_boolean('receive-files'))
                this._handleFile(packet);
            else
                this._refuseFile(packet);
        } else if (packet.body.hasOwnProperty('text')) {
            this._handleText(packet);
        } else if (packet.body.hasOwnProperty('url')) {
            this._handleUri(packet);
        }
    }

    _ensureReceiveDirectory() {
        let receiveDir = this.settings.get_string('receive-directory');

        // Ensure a directory is set
        if (receiveDir.length === 0) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            );

            // Fallback to ~/Downloads
            const homeDir = GLib.get_home_dir();

            if (!receiveDir || receiveDir === homeDir)
                receiveDir = GLib.build_filenamev([homeDir, 'Downloads']);

            this.settings.set_string('receive-directory', receiveDir);
        }

        // Ensure the directory exists
        if (!GLib.file_test(receiveDir, GLib.FileTest.IS_DIR))
            GLib.mkdir_with_parents(receiveDir, 448);

        return receiveDir;
    }

    _getFile(filename) {
        const dirpath = this._ensureReceiveDirectory();
        const basepath = GLib.build_filenamev([dirpath, filename]);
        let filepath = basepath;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS))
            filepath = `${basepath} (${++copyNum})`;

        return Gio.File.new_for_path(filepath);
    }

    _refuseFile(packet) {
        try {
            this.device.rejectTransfer(packet);

            this.device.showNotification({
                id: `${Date.now()}`,
                title: _('Transfer Failed'),
                // TRANSLATORS: eg. Google Pixel is not allowed to upload files
                body: _('%s is not allowed to upload files').format(
                    this.device.name
                ),
                icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
            });
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    async _handleFile(packet) {
        try {
            const file = this._getFile(packet.body.filename);

            // Create the transfer
            const transfer = this.device.createTransfer();

            transfer.addFile(packet, file);

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Transferring File'),
                // TRANSLATORS: eg. Receiving 'book.pdf' from Google Pixel
                body: _('Receiving “%s” from %s').format(
                    packet.body.filename,
                    this.device.name
                ),
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid),
                }],
                icon: new Gio.ThemedIcon({name: 'document-save-symbolic'}),
            });

            // We'll show a notification (success or failure)
            let title, body, action, iconName;
            let buttons = [];

            try {
                await transfer.start();

                title = _('Transfer Successful');
                // TRANSLATORS: eg. Received 'book.pdf' from Google Pixel
                body = _('Received “%s” from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                action = {
                    name: 'showPathInFolder',
                    parameter: new GLib.Variant('s', file.get_uri()),
                };
                buttons = [
                    {
                        label: _('Show File Location'),
                        action: 'showPathInFolder',
                        parameter: new GLib.Variant('s', file.get_uri()),
                    },
                    {
                        label: _('Open File'),
                        action: 'openPath',
                        parameter: new GLib.Variant('s', file.get_uri()),
                    },
                ];
                iconName = 'document-save-symbolic';

                const gtk_recent_manager = Gtk.RecentManager.get_default();
                gtk_recent_manager.add_item(file.get_uri());

                if (packet.body.open) {
                    const uri = file.get_uri();
                    Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
                }
            } catch (e) {
                debug(e, this.device.name);

                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to receive 'book.pdf' from Google Pixel
                body = _('Failed to receive “%s” from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                iconName = 'dialog-warning-symbolic';

                // Clean up the downloaded file on failure
                file.delete_async(GLib.PRIORITY_DEAFAULT, null, null);
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                action: action,
                buttons: buttons,
                icon: new Gio.ThemedIcon({name: iconName}),
            });
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    _handleUri(packet) {
        const uri = packet.body.url;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    _handleText(packet) {
        const dialog = new Gtk.MessageDialog({
            text: _('Text Shared By %s').format(this.device.name),
            secondary_text: URI.linkify(packet.body.text),
            secondary_use_markup: true,
            buttons: Gtk.ButtonsType.CLOSE,
        });
        dialog.message_area.get_children()[1].selectable = true;
        dialog.set_keep_above(true);
        dialog.connect('response', (dialog) => dialog.destroy());
        dialog.show();
    }

    /**
     * Open the file chooser dialog for selecting a file or inputing a URI.
     */
    share() {
        const dialog = new FileChooserDialog(this.device);
        dialog.show();
    }

    /**
     * Share local file path or URI
     *
     * @param {string} path - Local file path or URI
     * @param {boolean} open - Whether the file should be opened after transfer
     */
    async shareFile(path, open = false) {
        try {
            let file = null;

            if (path.includes('://'))
                file = Gio.File.new_for_uri(path);
            else
                file = Gio.File.new_for_path(path);

            // Create the transfer
            const transfer = this.device.createTransfer();

            transfer.addFile({
                type: 'kdeconnect.share.request',
                body: {
                    filename: file.get_basename(),
                    open: open,
                },
            }, file);

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Transferring File'),
                // TRANSLATORS: eg. Sending 'book.pdf' to Google Pixel
                body: _('Sending “%s” to %s').format(
                    file.get_basename(),
                    this.device.name
                ),
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid),
                }],
                icon: new Gio.ThemedIcon({name: 'document-send-symbolic'}),
            });

            // We'll show a notification (success or failure)
            let title, body, iconName;

            try {
                await transfer.start();

                title = _('Transfer Successful');
                // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                body = _('Sent “%s” to %s').format(
                    file.get_basename(),
                    this.device.name
                );
                iconName = 'document-send-symbolic';
            } catch (e) {
                debug(e, this.device.name);

                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to send "book.pdf" to Google Pixel
                body = _('Failed to send “%s” to %s').format(
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
                icon: new Gio.ThemedIcon({name: iconName}),
            });
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Share one or more local file paths
     *
     * @param {Array<String>} transferList - Array of local file paths
     * @param {boolean} open - Whether the file should be opened after transfer
     */
    async shareFiles(transferList, open = false) {
        if (transferList.length === 1)
            await this.shareFile(transferList[0], open);
        else
            await this.shareFilesWithTemps(transferList);
    }

    /**
     * Share one or more local file paths, and delete temporaries when done
     *
     * @param {Array<String>} transferList - Array of local file paths
     * @param {Array<String>} tempList - Temporary files that should be
     *                                   deleted after transfer
     */
    async shareFilesWithTemps(transferList, tempList = []) {
        try {

            if (!transferList)
                return;

            debug(transferList);

            const packet_list = [];
            let payload_size = 0;

            for (const path of transferList) {
                let file;

                if (path.includes('://'))
                    file = Gio.File.new_for_uri(path);
                else
                    file = Gio.File.new_for_path(path);

                const info = await file.query_info_async(
                    Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                const filesize = info.get_size();
                payload_size += filesize;

                const delete_after = tempList.includes(path);

                packet_list.push([
                    {
                        type: 'kdeconnect.share.request',
                        body: {
                            filename: file.get_basename(),
                            open: false,
                        },
                    },
                    file,
                    filesize,
                    delete_after,
                ]);

            }

            debug(packet_list);
            await this._do_transfer(packet_list, payload_size);

        } catch (e) {
            logError(e, `${this.device.name}: shareFilesWithTemps`);
        }
    }


    async _do_transfer(packet_list, payload_size) {
        try {
            // Create the transfer
            const transfer = this.device.createTransfer();

            const file_count = packet_list.length;
            transfer.setCountAndSize(file_count, payload_size);

            for (const [packet, file, size, deleteAfter] of packet_list)
                transfer.addFile(packet, file, size, deleteAfter);

            // Notify that we're about to start the transfer
            const notif_title = _('Transferring Files');
            // TRANSLATORS: eg. Sending 3 files to Google Pixel
            const notif_body = ngettext(
                'Sending %d file to %s',
                'Sending %d files to %s',
                file_count
            ).format(
                file_count,
                this.device.name
            );
            this.device.showNotification({
                id: transfer.uuid,
                title: notif_title,
                body: notif_body,
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid),
                }],
                icon: new Gio.ThemedIcon({name: 'document-send-symbolic'}),
            });

            // We'll show a notification (success or failure)
            let title, body, iconName;

            try {
                await transfer.start();

                title = _('Transfer Successful');
                // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                body = ngettext(
                    'Sent %d file to %s',
                    'Sent %d files to %s',
                    file_count
                ).format(
                    file_count,
                    this.device.name
                );
                iconName = 'document-send-symbolic';
            } catch (e) {
                debug(e, this.device.name);

                title = _('Transfer Failed');
                // TRANSLATORS: eg. File transfer to Google Pixel failed
                body = _('File transfer to %s failed').format(this.device.name);
                iconName = 'dialog-warning-symbolic';
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                icon: new Gio.ThemedIcon({name: iconName}),
            });
        } catch (e) {
            logError(e, `${this.device.name}: _do_transfer`);
        }
    }


    /**
     * Share a string of text. Remote behaviour is undefined.
     *
     * @param {string} text - A string of unicode text
     */
    shareText(text) {
        this.device.sendPacket({
            type: 'kdeconnect.share.request',
            body: {text: text},
        });
    }

    /**
     * Share a URI. Generally the remote device opens it with the scheme default
     *
     * @param {string} uri - A URI to share
     */
    shareUri(uri) {
        if (GLib.uri_parse_scheme(uri) === 'file') {
            this.shareFile(uri);
            return;
        }

        this.device.sendPacket({
            type: 'kdeconnect.share.request',
            body: {url: uri},
        });
    }
});


/** A simple FileChooserDialog for sharing files */
const FileChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectShareFileChooserDialog',
}, class FileChooserDialog extends Gtk.FileChooserDialog {

    _init(device) {
        super._init({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(device.name),
            select_multiple: true,
            extra_widget: new Gtk.CheckButton({
                // TRANSLATORS: Mark the file to be opened once completed
                label: _('Open when done'),
                visible: true,
            }),
            use_preview_label: false,
        });

        this.device = device;

        // Align checkbox with sidebar
        const box = this.get_content_area().get_children()[0].get_children()[0];
        const paned = box.get_children()[0];
        paned.bind_property(
            'position',
            this.extra_widget,
            'margin-left',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Preview Widget
        this.preview_widget = new Gtk.Image();
        this.preview_widget_active = false;
        this.connect('update-preview', this._onUpdatePreview);

        // URI entry
        this._uriEntry = new Gtk.Entry({
            placeholder_text: 'https://',
            hexpand: true,
            visible: true,
        });
        this._uriEntry.connect('activate', this._sendLink.bind(this));

        // URI/File toggle
        this._uriButton = new Gtk.ToggleButton({
            image: new Gtk.Image({
                icon_name: 'web-browser-symbolic',
                pixel_size: 16,
            }),
            valign: Gtk.Align.CENTER,
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _('Send a link to %s').format(device.name),
            visible: true,
        });
        this._uriButton.connect('toggled', this._onUriButtonToggled.bind(this));

        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const sendButton = this.add_button(_('Send'), Gtk.ResponseType.OK);
        sendButton.connect('clicked', this._sendLink.bind(this));

        this.get_header_bar().pack_end(this._uriButton);
        this.set_default_response(Gtk.ResponseType.OK);
    }

    _onUpdatePreview(chooser) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(
                chooser.get_preview_filename(),
                chooser.get_scale_factor() * 128,
                -1
            );
            chooser.preview_widget.pixbuf = pixbuf;
            chooser.preview_widget.visible = true;
            chooser.preview_widget_active = true;
        } catch (e) {
            chooser.preview_widget.visible = false;
            chooser.preview_widget_active = false;
        }
    }

    _onUriButtonToggled(button) {
        const header = this.get_header_bar();

        // Show the URL entry
        if (button.active) {
            this.extra_widget.sensitive = false;
            header.set_custom_title(this._uriEntry);
            this.set_response_sensitive(Gtk.ResponseType.OK, true);

        // Hide the URL entry
        } else {
            header.set_custom_title(null);
            this.set_response_sensitive(
                Gtk.ResponseType.OK,
                this.get_uris().length > 1
            );
            this.extra_widget.sensitive = true;
        }
    }

    _sendLink(widget) {
        if (this._uriButton.active && this._uriEntry.text.length)
            this.response(1);
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            const uris = [];
            for (const uri of this.get_uris())
                uris.push(uri);
            const parameters = new GLib.Variant('(asb)', [
                uris,
                this.extra_widget.active,
            ]);
            debug(parameters.deepUnpack());
            this.device.activate_action('shareFiles', parameters);
        } else if (response_id === 1) {
            const parameter = new GLib.Variant('s', this._uriEntry.text);
            this.device.activate_action('shareUri', parameter);
        }

        this.destroy();
    }
});

export default SharePlugin;
