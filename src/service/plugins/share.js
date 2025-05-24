// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import Plugin from '../plugin.js';
import * as URI from '../utils/uri.js';


export const Metadata = {
    label: _('Share'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
    description: _('Share files and URLs between devices'),
    incomingCapabilities: ['kdeconnect.share.request'],
    outgoingCapabilities: ['kdeconnect.share.request'],
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
        const dialog = new Adw.AlertDialog({
            heading: _('Text Shared By %s').format(this.device.name),
            body: URI.linkify(packet.body.text),
            default_response: 'close',
        });
        dialog.add_response('close', _('Close'));
        dialog.present(Gio.Application.get_default().get_active_window());
    }

    /**
     * Open the file chooser dialog for selecting a file or inputing a URI.
     */
    share() {
        const win = new Adw.Window({
            default_width: 400,
            default_height: 300,
        });

        win.connect('destroy', () => Gtk.main_quit());

        const fileDialog = new Gtk.FileDialog({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(this.device.name),
        });

        fileDialog.open(win, null, (dialog, result) => {
            try {
                const file = fileDialog.open_finish(result);
                console.log('Selected file:', file.get_path());
                this.shareFile(file.get_path());
            } catch {
                console.log('No file selected');
            }
        });
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

export default SharePlugin;
