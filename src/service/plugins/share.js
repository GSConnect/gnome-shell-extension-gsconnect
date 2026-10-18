// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
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
        const {filename, text, url} = packet.body;

        // TODO: composite jobs (lastModified, numberOfFiles, totalPayloadSize)
        if (filename !== undefined) {
            debug(`Remote wants to share file "${filename}".`);
            if (this.settings.get_boolean('receive-files'))
                this._handleFile(packet);
            else
                this._refuseFile(packet);
            return;
        }
        if (text === undefined && url === undefined)
            throw new Error('Share request has invalid payload, ignoring.');

        if (this.settings.get_boolean('launch-urls')) {
            let shared_url = url;
            if (url === undefined) {
                const urls = URI.findUrls(text);
                if (urls.length === 1)
                    shared_url = urls[0].url;
            }
            if (shared_url !== undefined) {
                debug(`Launching shared URL "${shared_url}".`);
                return this._handleUri(shared_url);
            }
        }
        const message = text || url;
        debug('Displaying shared message.');
        this._handleText(message);
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

        // Remote-supplied filename is untrusted;
        // collapse to a basename so it can't escape the download dir
        // via '../' or an absolute path.
        let basename = GLib.path_get_basename(filename);
        if (!basename || basename === '.' || basename === '..' ||
            basename.includes('/'))
            basename = 'unnamed-file';

        const basepath = GLib.build_filenamev([dirpath, basename]);
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

    _handleUri(uri) {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    _handleText(message) {
        const dialog = new Adw.Window({
            application: Gio.Application.get_default(),
            default_width: 400,
            default_height: 240,
            title: _('Text Shared By %s').format(this.device.name),
        });

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_content(toolbar);

        const label = new Gtk.Label({
            label: URI.linkify(message),
            use_markup: true,
            selectable: true,
            wrap: true,
            xalign: 0,
            yalign: 0,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 18,
            margin_end: 18,
        });
        toolbar.set_content(new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: label,
        }));

        dialog.present();
    }

    /**
     * Open the file chooser dialog for selecting a file or inputing a URI.
     */
    share() {
        const dialog = new FileChooserDialog(this.device);
        dialog.present();
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


/** A simple dialog for sharing files or links */
const FileChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectShareFileChooserDialog',
}, class FileChooserDialog extends Adw.Window {

    _init(device) {
        super._init({
            application: Gio.Application.get_default(),
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(device.name),
            default_width: 420,
        });

        this.device = device;

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.set_content(toolbar);

        const page = new Adw.PreferencesPage();
        toolbar.set_content(page);

        // Files
        const files = new Adw.PreferencesGroup();
        page.add(files);

        this._openRow = new Adw.SwitchRow({
            // TRANSLATORS: Mark the file to be opened once completed
            title: _('Open when done'),
        });

        const choose = new Adw.ActionRow({
            title: _('Choose Files…'),
            activatable: true,
        });
        choose.add_prefix(new Gtk.Image({icon_name: 'document-send-symbolic'}));
        choose.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        choose.connect('activated', this._onChooseFiles.bind(this));
        files.add(choose);
        files.add(this._openRow);

        // Link
        const links = new Adw.PreferencesGroup();
        page.add(links);

        this._uriRow = new Adw.EntryRow({
            // TRANSLATORS: eg. Send a link to Google Pixel
            title: _('Send a link to %s').format(device.name),
            show_apply_button: true,
            input_purpose: Gtk.InputPurpose.URL,
        });
        this._uriRow.connect('apply', this._sendLink.bind(this));
        links.add(this._uriRow);
    }

    async _onChooseFiles() {
        try {
            const dialog = new Gtk.FileDialog({title: this.title});
            const files = await dialog.open_multiple(this, null);

            for (let i = 0; i < files.get_n_items(); i++) {
                const parameter = new GLib.Variant(
                    '(sb)',
                    [files.get_item(i).get_uri(), this._openRow.active]
                );
                this.device.activate_action('shareFile', parameter);
            }

            this.close();
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                !e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                logError(e);
        }
    }

    _sendLink() {
        const text = this._uriRow.text.trim();

        if (!text)
            return;

        this.device.activate_action('shareUri', new GLib.Variant('s', text));
        this.close();
    }
});

export default SharePlugin;
