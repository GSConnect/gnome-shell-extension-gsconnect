// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Components from '../components/index.js';
import Plugin from '../plugin.js';
import {
    MAX_IMAGE_PIXELS,
    decodeImage,
    encodePng,
    getImageChecksum,
    getImageInfo
} from '../utils/image.js';


export const Metadata = {
    label: _('Clipboard'),
    description: _('Share the clipboard content'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
        'kdeconnect.clipboard.file',
    ],
    outgoingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
        'kdeconnect.clipboard.file',
    ],
    actions: {
        clipboardPush: {
            label: _('Clipboard Push'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard'],
        },
        clipboardPull: {
            label: _('Clipboard Pull'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: [],
        },
    },
};


/**
 * The maximum size of a file or image shared through the clipboard. This is the
 * same as the default of KDE Connect.
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024;


/**
 * Check if two clipboard contents are the same.
 *
 * @param {object|null} a - A clipboard content
 * @param {object|null} b - A clipboard content
 * @returns {boolean} %true if the contents are the same
 */
function isSameContent(a, b) {
    if (a === null || b === null || a.type !== b.type)
        return false;

    switch (a.type) {
        case 'text':
            return a.text === b.text;

        case 'file':
            return a.uri === b.uri;

        case 'image':
            return a.checksum === b.checksum;
    }

    return false;
}


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
const ClipboardPlugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class ClipboardPlugin extends Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._clipboard = Components.acquire('clipboard');

        // Watch local clipboard for changes
        this._contentChangedId = this._clipboard.connect(
            'content-changed',
            this._onLocalClipboardChanged.bind(this)
        );

        // Buffer content to allow selective sync
        this._localBuffer = this._clipboard.text;
        this._localTimestamp = 0;

        // The last content received from or sent to the device
        this._remoteContent = null;

        // The last content applied to the local clipboard from the device
        this._pulledContent = null;

        // The pending transfers of a file or image to and from the device
        this._outgoingTransfer = null;
        this._incomingTransfer = null;

        // Directories of files being received, which must not be cleaned up
        this._receivingDirs = new Set();

        // Serials, to ignore operations superseded by a clipboard change
        this._localSerial = 0;
        this._remoteSerial = 0;
    }

    connected() {
        super.connected();

        // The remote clipboard may have changed while disconnected
        this._remoteContent = null;
        this._pulledContent = null;

        // TODO: if we're not auto-syncing local->remote, but we are doing the
        //       reverse, it's possible older remote content will end up
        //       overwriting newer local content.
        if (!this.settings.get_boolean('send-content'))
            return;

        // Files and images are not sent on connection
        if (typeof this._localBuffer !== 'string')
            return;

        if (this._localBuffer === '' && this._localTimestamp === 0)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.clipboard.connect',
            body: {
                content: this._localBuffer,
                timestamp: this._localTimestamp,
            },
        });
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.clipboard':
                if (typeof packet.body.content === 'string')
                    this._handleContent(packet);
                break;

            case 'kdeconnect.clipboard.connect':
                if (typeof packet.body.content === 'string')
                    this._handleConnectContent(packet);
                break;

            case 'kdeconnect.clipboard.file':
                this._handleFile(packet);
                break;
        }
    }

    _handleContent(packet) {
        this._onRemoteClipboardChanged(packet.body.content);
    }

    _handleConnectContent(packet) {
        if (packet.body.hasOwnProperty('timestamp') &&
            packet.body.timestamp > this._localTimestamp)
            this._onRemoteClipboardChanged(packet.body.content);
    }

    /**
     * Get the directory for files received through the clipboard.
     *
     * @returns {Gio.File} The directory
     */
    _getReceiveDirectory() {
        const path = GLib.build_filenamev([
            Config.CACHEDIR,
            this.device.id,
            'clipboard',
        ]);
        GLib.mkdir_with_parents(path, 448);

        return Gio.File.new_for_path(path);
    }

    /**
     * Recursively delete the contents of a directory.
     *
     * @param {Gio.File} dir - A directory
     * @param {function(Gio.File): boolean} [keep] - Selects children to keep
     */
    async _deleteChildren(dir, keep = null) {
        const iter = await dir.enumerate_children_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            ].join(','),
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);

        try {
            let infos;
            while ((infos = await iter.next_files_async(10,
                GLib.PRIORITY_DEFAULT, this.cancellable)).length > 0) {
                for (const info of infos) {
                    const child = iter.get_child(info);

                    if (keep?.(child))
                        continue;

                    try {
                        if (info.get_file_type() === Gio.FileType.DIRECTORY)
                            await this._deleteChildren(child);

                        await child.delete_async(GLib.PRIORITY_DEFAULT,
                            this.cancellable);
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            throw e;
                    }
                }
            }
        } finally {
            iter.close(null);
        }
    }

    /**
     * Remove previously received files, which are no longer in the clipboard.
     *
     * @param {Gio.File} dir - The receive directory
     * @param {Gio.File} current - The directory of the current file
     */
    async _cleanReceiveDirectory(dir, current) {
        try {
            await this._deleteChildren(dir, child => child.equal(current) ||
                this._receivingDirs.has(child.get_path()));
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    /**
     * Remove a directory and its contents.
     *
     * @param {Gio.File} dir - A directory
     */
    async _removeDirectory(dir) {
        try {
            await this._deleteChildren(dir);
            await dir.delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                debug(e, this.device.name);
        }
    }

    async _handleFile(packet) {
        if (!packet.hasPayload() || typeof packet.body.filename !== 'string') {
            debug('Ignoring clipboard file without payload or filename',
                this.device.name);
            return;
        }

        // The remote clipboard changed, regardless of the file being accepted
        this._cancelIncomingTransfer();
        const serial = ++this._remoteSerial;
        this._remoteContent = null;

        // Only download files that will be applied to the clipboard
        if (!this.settings.get_boolean('receive-content') ||
            !(packet.payloadSize >= 0 && packet.payloadSize <= MAX_FILE_SIZE)) {
            this.device.rejectTransfer(packet);
            return;
        }

        let dir = null;

        try {
            // Remote-supplied filename is untrusted; collapse to a basename so
            // it can't escape the receive directory
            let basename = GLib.path_get_basename(packet.body.filename);
            if (!basename || basename === '.' || basename === '..' ||
                basename.includes('/'))
                basename = 'unnamed-file';

            // Each file gets its own directory, so a superseded transfer can
            // be removed without affecting a newer file of the same name
            const receiveDir = this._getReceiveDirectory();
            dir = receiveDir.get_child(`${Date.now()}-${serial}`);
            dir.make_directory(null);
            this._receivingDirs.add(dir.get_path());

            const file = dir.get_child(basename);
            const transfer = this.device.createTransfer();
            transfer.addFile(packet, file);

            this._incomingTransfer = transfer;

            try {
                await transfer.start(this.cancellable);
            } finally {
                if (this._incomingTransfer === transfer)
                    this._incomingTransfer = null;
            }

            const content = await this._loadFile(file);

            // Ignore files superseded by newer clipboard content
            if (serial !== this._remoteSerial) {
                await this._removeDirectory(dir);
                return;
            }

            // Remove previously received files, now that this one replaces
            // them in the clipboard
            await this._cleanReceiveDirectory(receiveDir, dir);

            // Check again, since cleaning up is asynchronous
            if (serial !== this._remoteSerial) {
                await this._removeDirectory(dir);
                return;
            }

            this._onRemoteClipboardChanged(content);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            if (dir !== null)
                await this._removeDirectory(dir);
        } finally {
            if (dir !== null)
                this._receivingDirs.delete(dir.get_path());
        }
    }

    /**
     * Get the clipboard content for a received file. Images are placed in the
     * clipboard as image data, while other files are placed as a file.
     *
     * @param {Gio.File} file - A received file
     * @returns {Promise<object>} A clipboard content
     */
    async _loadFile(file) {
        const info = await file.query_info_async(
            Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);
        const contentType = info.get_content_type();
        const mimetype = Gio.content_type_get_mime_type(contentType);

        if (mimetype?.startsWith('image/') && mimetype !== 'image/svg+xml') {
            try {
                // Check the dimensions before decoding an untrusted image
                const [format, width, height] = await getImageInfo(file,
                    this.cancellable);

                if (format === null || width * height > MAX_IMAGE_PIXELS)
                    throw new Error(`Unsupported image: ${width}x${height}`);

                const [contents] = await file.load_contents_async(
                    this.cancellable);
                const pixbuf = await decodeImage(new GLib.Bytes(contents),
                    this.cancellable);

                // The image data is read again when applied, to avoid
                // keeping it in memory
                return {
                    type: 'image',
                    checksum: getImageChecksum(pixbuf),
                    mimetype: mimetype,
                    uri: file.get_uri(),
                };
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;

                debug(`Failed to load image: ${e.message}`, this.device.name);
            }
        }

        return {type: 'file', uri: file.get_uri()};
    }

    /*
     * Store the local clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard) {
        const content = clipboard.content;

        // Like KDE Connect, ignore a cleared clipboard
        if (content === null || (content.type === 'text' && content.text === ''))
            return;

        this._localSerial++;
        this._localBuffer = content.type === 'text' ? content.text : null;
        this._localTimestamp = Date.now();

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(content) {
        if (typeof content === 'string')
            content = {type: 'text', text: content};

        // Supersede any file still being received
        if (content.type === 'text') {
            this._cancelIncomingTransfer();
            this._remoteSerial++;
        }

        this._remoteContent = content;

        if (this.settings.get_boolean('receive-content'))
            this.clipboardPull();
    }

    /**
     * Get the current local clipboard content, including the data of images.
     *
     * @returns {Promise<object|null>} A clipboard content
     */
    async _getLocalContent() {
        const content = this._clipboard.content;

        if (content?.type !== 'image')
            return content;

        const image = await this._clipboard.getImage();

        if (image === null)
            return null;

        return {type: 'image', bytes: image.bytes, checksum: image.checksum};
    }

    /**
     * Whether the device accepts files and images through the clipboard.
     *
     * @returns {boolean} %true if supported
     */
    _canSendFiles() {
        if (!this.device.connected)
            return false;

        const incoming = this.device.settings.get_strv('incoming-capabilities');
        return incoming.includes('kdeconnect.clipboard.file');
    }

    /**
     * Cancel the pending transfer of a file or image from the device, which
     * has been superseded by newer clipboard content.
     */
    _cancelIncomingTransfer() {
        if (this._incomingTransfer !== null) {
            this._incomingTransfer.cancel();
            this._incomingTransfer = null;
        }
    }

    /**
     * Cancel the pending transfer of a file or image, which has been
     * superseded by newer clipboard content.
     */
    _cancelOutgoingTransfer() {
        if (this._outgoingTransfer !== null) {
            this._outgoingTransfer.cancel();
            this._outgoingTransfer = null;
        }
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    async clipboardPush() {
        // Don't sync if the clipboard is empty or unknown
        if (this._localTimestamp === 0)
            return;

        try {
            const serial = this._localSerial;
            const content = await this._getLocalContent();

            // Ignore content superseded by a newer clipboard change
            if (content === null || serial !== this._localSerial ||
                this.cancellable.is_cancelled())
                return;

            if (isSameContent(content, this._remoteContent))
                return;

            // Don't send back content applied from the device
            if (isSameContent(content, this._pulledContent))
                return;

            this._pulledContent = null;

            switch (content.type) {
                case 'text':
                    this._cancelOutgoingTransfer();
                    this._remoteContent = content;
                    this.device.sendPacket({
                        type: 'kdeconnect.clipboard',
                        body: {
                            content: content.text,
                        },
                    });
                    break;

                case 'image':
                    await this._sendImage(content);
                    break;

                case 'file':
                    await this._sendFile(content, serial);
                    break;
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    async _startTransfer(transfer, content) {
        this._cancelOutgoingTransfer();
        this._outgoingTransfer = transfer;

        try {
            await transfer.start(this.cancellable);
        } catch (e) {
            // Allow the content to be sent again
            if (this._remoteContent === content)
                this._remoteContent = null;

            throw e;
        } finally {
            if (this._outgoingTransfer === transfer)
                this._outgoingTransfer = null;
        }
    }

    async _sendImage(content) {
        if (!this._canSendFiles())
            return;

        const size = content.bytes.get_size();

        if (size > MAX_FILE_SIZE) {
            debug('Clipboard image exceeds the maximum size', this.device.name);
            return;
        }

        // Only the checksum is kept, to avoid keeping the image in memory
        const remoteContent = {type: 'image', checksum: content.checksum};
        this._remoteContent = remoteContent;

        const transfer = this.device.createTransfer();
        transfer.addStream({
            type: 'kdeconnect.clipboard.file',
            body: {
                filename: `${Date.now()}.png`,
            },
        }, Gio.MemoryInputStream.new_from_bytes(content.bytes), size);

        await this._startTransfer(transfer, remoteContent);
    }

    async _sendFile(content, serial) {
        if (!this._canSendFiles())
            return;

        const file = Gio.File.new_for_uri(content.uri);
        const info = await file.query_info_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            ].join(','),
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);

        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            debug(`Not a regular file: ${content.uri}`, this.device.name);
            return;
        }

        if (info.get_size() > MAX_FILE_SIZE) {
            debug(`Clipboard file exceeds the maximum size: ${content.uri}`,
                this.device.name);
            return;
        }

        // Ignore content superseded while querying the file
        if (serial !== this._localSerial)
            return;

        this._remoteContent = content;

        const transfer = this.device.createTransfer();
        transfer.addFile({
            type: 'kdeconnect.clipboard.file',
            body: {
                filename: file.get_basename(),
            },
        }, file);

        await this._startTransfer(transfer, content);
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        const content = this._remoteContent;

        if (content === null)
            return;

        switch (content.type) {
            case 'text':
                if (this._localBuffer !== content.text) {
                    this._localBuffer = content.text;
                    this._localTimestamp = Date.now();

                    this._clipboard.text = content.text;
                }
                this._pulledContent = content;
                break;

            case 'image':
                // Images sent to the device have no file to apply
                if (content.uri === undefined)
                    break;

                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = content;
                this._applyImage(content);
                break;

            case 'file':
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = this._clipboard.setFile(content.uri);
                break;
        }
    }

    /**
     * Place a received image in the clipboard as PNG data.
     *
     * @param {object} content - A received image
     */
    async _applyImage(content) {
        try {
            const file = Gio.File.new_for_uri(content.uri);
            const [contents] = await file.load_contents_async(this.cancellable);
            let bytes = new GLib.Bytes(contents);

            if (content.mimetype !== 'image/png') {
                const pixbuf = await decodeImage(bytes, this.cancellable);
                bytes = await encodePng(pixbuf, this.cancellable);
            }

            // Ignore the image if the clipboard changed in the meantime
            if (this._pulledContent === content)
                this._clipboard.setImage(bytes);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    destroy() {
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();

        if (this._clipboard && this._contentChangedId) {
            this._clipboard.disconnect(this._contentChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});

export default ClipboardPlugin;
