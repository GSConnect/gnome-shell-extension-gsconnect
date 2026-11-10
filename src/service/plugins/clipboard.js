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
    MAX_FILE_SIZE,
    decodeImageFile,
    encodePng,
    getImageChecksum,
    getImageFormat,
    loadBytes
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
    // Images and files are only shared when enabled
    capabilitySettings: {
        'kdeconnect.clipboard.file': 'clipboard-files',
    },
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
 * The maximum number of contents applied from a device, which are expected to
 * be reported as local clipboard changes, and the time in milliseconds they
 * are expected for. A device may send many in quick succession, but content
 * that was never reported mustn't be mistaken for a later copy of it.
 */
const MAX_PENDING_ECHOES = 32;
const ECHO_TIMEOUT = 10000;

/**
 * The clipboard plugins of all devices, which apply content to the same
 * clipboard.
 */
const clipboardPlugins = new Set();

/**
 * Local clipboard changes recognized as content applied from a device, and
 * when that content was applied, so other devices' plugins can tell.
 */
const appliedReports = new WeakMap();


/**
 * The maximum length in bytes of the name of a received file, which leaves
 * room for a PNG copy within the usual limit of 255 bytes.
 */
const MAX_BASENAME = 200;


/**
 * The interval in milliseconds at which the size of a file being received is
 * checked.
 */
const SIZE_CHECK_INTERVAL = 100;


/**
 * Get the size of a file.
 *
 * @param {Gio.File} file - A file
 * @returns {number} The size in bytes, or 0 if it can't be read
 */
function getFileSize(file) {
    try {
        return file.query_info(Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch {
        return 0;
    }
}


/**
 * Get a safe local name for a file received from a device.
 *
 * @param {string} filename - The untrusted name chosen by the device
 * @returns {string} A file name
 */
function getSafeBasename(filename) {
    // Collapse to a basename, so it can't escape the receive directory, and
    // replace control characters, so its path is a single line of text, and
    // bidirectional controls, so its extension is displayed as it is
    const basename = GLib.path_get_basename(filename)
        .replace(/[\p{Cc}\p{Bidi_Control}]/gu, '_');

    if (!basename || basename === '.' || basename === '..' ||
        basename.includes('/'))
        return 'unnamed-file';

    const encoder = new TextEncoder();

    if (encoder.encode(basename).length <= MAX_BASENAME)
        return basename;

    // Shorten the name, keeping a reasonable extension
    const dot = basename.lastIndexOf('.');
    let extension = dot > 0 ? basename.slice(dot) : '';

    if (encoder.encode(extension).length > 16)
        extension = '';

    const chars = Array.from(basename.slice(0, basename.length -
        extension.length)).slice(0, MAX_BASENAME);

    while (chars.length > 0 &&
        encoder.encode(chars.join('') + extension).length > MAX_BASENAME)
        chars.pop();

    return `${chars.join('') || 'unnamed-file'}${extension}`;
}


/**
 * Check if a file was received through the clipboard from any device.
 *
 * @param {Gio.File} file - A file
 * @returns {boolean} %true if the file was received from a device
 */
function isReceivedFile(file) {
    const cachedir = Gio.File.new_for_path(Config.CACHEDIR);
    const path = cachedir.get_relative_path(file);

    // See ClipboardPlugin._getReceiveDirectory()
    return path !== null && path.split('/')[1] === 'clipboard';
}


/**
 * Check if text is the path of a file received through the clipboard, which
 * is how files are placed in a clipboard that can't hold a file list.
 *
 * @param {string} text - Clipboard text
 * @returns {boolean} %true if the text is the path of a received file
 */
function isReceivedPath(text) {
    return GLib.path_is_absolute(text) && !text.includes('\n') &&
        isReceivedFile(Gio.File.new_for_path(text));
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

        // Sharing images and files is a global setting. Transfers stop when
        // it's disabled, but it only applies to sending once the device was
        // told, when it connects.
        this._serviceSettings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
        });
        this._filesChangedId = this._serviceSettings.connect(
            'changed::clipboard-files', this._onFilesChanged.bind(this));

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

        // Cancels receiving, loading and converting a file from the device,
        // and applying a received image
        this._incomingCancellable = null;
        this._applyCancellable = null;
        this._applyingContent = null;

        // Directories of files being received, which must not be cleaned up
        this._receivingDirs = new Set();

        // The directory of the received file in the clipboard, if any
        this._currentDir = null;

        // Contents applied from the device, which are yet to be reported as
        // local clipboard changes, oldest first, and when each was applied
        this._pendingEchoes = [];
        this._echoTimes = new WeakMap();

        // Serials, to ignore operations superseded by a clipboard change
        this._localSerial = 0;
        this._remoteSerial = 0;

        // When content from the device was last applied, or started being
        // received, and when it was last applied, in monotonic time
        this._remoteTime = 0;
        this._appliedTime = 0;

        clipboardPlugins.add(this);
    }

    connected() {
        super.connected();

        // The remote clipboard may have changed while disconnected, and
        // content applied before won't be reported now
        this._remoteContent = null;
        this._pulledContent = null;
        this._pendingEchoes = [];

        // TODO: if we're not auto-syncing local->remote, but we are doing the
        //       reverse, it's possible older remote content will end up
        //       overwriting newer local content.
        if (!this.settings.get_boolean('send-content'))
            return;

        // Files and images are not sent on connection
        if (typeof this._localBuffer !== 'string' ||
            isReceivedPath(this._localBuffer))
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

    disconnected() {
        super.disconnected();

        // Pending transfers can't complete without a connection, but a file
        // received in full is still applied
        if (this._incomingTransfer !== null) {
            this._incomingTransfer.cancel();
            this._incomingTransfer = null;
        }

        this._cancelOutgoingTransfer();
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
        const dir = this._getReceivePath();
        GLib.mkdir_with_parents(dir.get_path(), 448);

        return dir;
    }

    /**
     * Get the directory for files received through the clipboard, without
     * creating it.
     *
     * @returns {Gio.File} The directory
     */
    _getReceivePath() {
        return Gio.File.new_for_path(GLib.build_filenamev([
            Config.CACHEDIR,
            this.device.id,
            'clipboard',
        ]));
    }

    /**
     * Recursively delete the contents of a directory.
     *
     * @param {Gio.File} dir - A directory
     * @param {function(Gio.File): boolean} [keep] - Selects children to keep
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     */
    async _deleteChildren(dir, keep = null, cancellable = null) {
        const iter = await dir.enumerate_children_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            ].join(','),
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable);

        try {
            let infos;
            while ((infos = await iter.next_files_async(10,
                GLib.PRIORITY_DEFAULT, cancellable)).length > 0) {
                for (const info of infos) {
                    const child = iter.get_child(info);

                    if (keep?.(child))
                        continue;

                    try {
                        if (info.get_file_type() === Gio.FileType.DIRECTORY)
                            await this._deleteChildren(child, null, cancellable);

                        await child.delete_async(GLib.PRIORITY_DEFAULT,
                            cancellable);
                    } catch (e) {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            throw e;
                    }
                }
            }
        } finally {
            iter.close(null);
        }
    }

    /**
     * Remove received files, which are no longer in the clipboard.
     *
     * @param {Gio.File} dir - The receive directory
     */
    async _cleanReceiveDirectory(dir) {
        // The kept directories are checked as each is reached, since they may
        // change while cleaning up. The file the device holds is kept too,
        // since it can be pulled again after a local copy.
        const keep = child => this._isCurrentDirectory(child) ||
            this._receivingDirs.has(child.get_path()) ||
            this._isRemoteDirectory(child);

        try {
            await this._deleteChildren(dir, keep, this.cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    /**
     * Check if a directory holds the file or image the device last sent.
     *
     * @param {Gio.File} dir - A directory
     * @returns {boolean} %true if it holds the device's content
     */
    _isRemoteDirectory(dir) {
        const uri = this._remoteContent?.uri;

        if (uri === undefined)
            return false;

        return Gio.File.new_for_uri(uri).get_parent()?.equal(dir) ?? false;
    }

    /**
     * Remove a directory and its contents.
     *
     * This is not cancellable, so a partially received file is removed even
     * if the plugin is destroyed.
     *
     * @param {Gio.File} dir - A directory
     */
    async _removeDirectory(dir) {
        try {
            await this._deleteChildren(dir);
            await dir.delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                debug(e, this.device.name);
        }
    }

    async _handleFile(packet) {
        if (!packet.hasPayload())
            return;

        if (typeof packet.body.filename !== 'string') {
            debug('Rejecting clipboard file without a filename',
                this.device.name);
            this.device.rejectTransfer(packet);
            return;
        }

        // The remote clipboard changed, regardless of the file being accepted
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();
        const serial = ++this._remoteSerial;
        this._remoteContent = null;

        // Only download files that will be applied to the clipboard
        if (!this._serviceSettings.get_boolean('clipboard-files') ||
            !this.settings.get_boolean('receive-content') ||
            !(packet.payloadSize >= 0 && packet.payloadSize <= MAX_FILE_SIZE)) {
            this.device.rejectTransfer(packet);
            return;
        }

        // Content applied from another device before is superseded by the
        // file, unless it isn't applied
        const startTime = GLib.get_monotonic_time();
        this._remoteTime = startTime;

        let dir = null;
        let received = false;

        // Cancelled when superseded, or when the plugin is destroyed
        const cancellable = new Gio.Cancellable();
        const pluginCancellable = this.cancellable;
        const cancelledId = pluginCancellable.connect(() => cancellable.cancel());
        this._incomingCancellable = cancellable;

        try {
            const basename = getSafeBasename(packet.body.filename);

            // Each file gets its own directory, so a superseded transfer can
            // be removed without affecting a newer file of the same name
            const receiveDir = this._getReceiveDirectory();
            const newDir = receiveDir.get_child(`${Date.now()}-${serial}`);
            newDir.make_directory(null);

            // The directory is only removed on failure once it was created
            dir = newDir;
            this._receivingDirs.add(dir.get_path());

            const file = dir.get_child(basename);
            const transfer = this.device.createTransfer();
            transfer.addFile(packet, file);

            this._incomingTransfer = transfer;

            // Devices may send more than the size they declared, so the file
            // is checked while it is received and once it is complete
            let sizeCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                SIZE_CHECK_INTERVAL, () => {
                    if (getFileSize(file) <= MAX_FILE_SIZE)
                        return GLib.SOURCE_CONTINUE;

                    debug('Clipboard file exceeded its size while received',
                        this.device.name);
                    sizeCheckId = 0;
                    cancellable.cancel();

                    return GLib.SOURCE_REMOVE;
                });

            try {
                await transfer.start(cancellable);
            } finally {
                if (sizeCheckId !== 0)
                    GLib.Source.remove(sizeCheckId);

                if (this._incomingTransfer === transfer)
                    this._incomingTransfer = null;
            }

            received = true;

            if (getFileSize(file) > MAX_FILE_SIZE)
                throw new Error('Clipboard file exceeded its size');

            const content = await this._loadFile(file, cancellable);

            // Ignore files superseded by newer clipboard content, unless the
            // clipboard holds the file since
            if (serial !== this._remoteSerial || cancellable.is_cancelled()) {
                if (!this._isCurrentDirectory(dir))
                    await this._removeDirectory(dir);
                return;
            }

            this._currentDir = dir;
            this._receivingDirs.delete(dir.get_path());
            this._onRemoteClipboardChanged(content);

            // Remove previously received files, which this one replaces
            await this._cleanReceiveDirectory(receiveDir);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            // Don't leave the device waiting to send the file, which may not
            // have been downloaded at all if the transfer was cancelled
            // before connecting, unless the device is gone
            if (!received && this.device.connected)
                this.device.rejectTransfer(packet);

            // The clipboard may hold a file in the directory since
            if (dir !== null && !this._isCurrentDirectory(dir))
                await this._removeDirectory(dir);
        } finally {
            if (dir !== null)
                this._receivingDirs.delete(dir.get_path());

            // Unless applied or superseded by another file, only content
            // applied before supersedes other devices'
            if (this._remoteTime === startTime)
                this._remoteTime = this._appliedTime;

            pluginCancellable.disconnect(cancelledId);

            if (this._incomingCancellable === cancellable)
                this._incomingCancellable = null;
        }
    }

    /**
     * Get the clipboard content for a received file. Images are placed in the
     * clipboard as image data, while other files are placed as a file.
     *
     * @param {Gio.File} file - A received file
     * @param {Gio.Cancellable} cancellable - A cancellable
     * @returns {Promise<object>} A clipboard content
     */
    async _loadFile(file, cancellable) {
        // The name of the file is chosen by the device, so images are
        // recognized from their contents, before passing them to a loader
        const format = await getImageFormat(file, cancellable);

        if (format !== null) {
            try {
                return await this._loadImage(file, format, cancellable);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;

                debug(`Failed to load image: ${e.message}`, this.device.name);
            }
        }

        return {type: 'file', uri: file.get_uri()};
    }

    /**
     * Get the clipboard content for a received image.
     *
     * Images that aren't PNG are converted, and the PNG data is written next
     * to the received file, so it doesn't have to be kept in memory.
     *
     * @param {Gio.File} file - A received image
     * @param {string} format - The format of the image
     * @param {Gio.Cancellable} cancellable - A cancellable
     * @returns {Promise<object>} A clipboard content
     */
    async _loadImage(file, format, cancellable) {
        const pixbuf = await decodeImageFile(file, cancellable, format);
        cancellable.set_error_if_cancelled();

        let pngFile = file;

        if (format !== 'png') {
            const bytes = await encodePng(pixbuf, cancellable);

            if (bytes.get_size() > MAX_FILE_SIZE)
                throw new Error('Image is too large once converted to PNG');

            pngFile = file.get_parent().get_child(`${file.get_basename()}.png`);
            await pngFile.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE, cancellable);
        }

        return {
            type: 'image',
            checksum: await getImageChecksum(pixbuf, cancellable),
            uri: pngFile.get_uri(),
        };
    }

    /*
     * Store the local clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard) {
        const content = clipboard.content;

        // Like KDE Connect, ignore a cleared clipboard
        if (content === null || (content.type === 'text' && content.text === ''))
            return;

        const applied = this._getAppliedContent(content);

        // Content another device applied is superseded by content applied
        // from this device since, even if the clipboard only reads it back
        // after that, so it's ignored rather than sent to this device
        if (applied === null && this._isSupersededElsewhere(content))
            return;

        this._localSerial++;
        this._localBuffer = content.type === 'text' ? content.text : null;
        this._localTimestamp = Date.now();

        // Supersede any content still being received or applied from the
        // device, unless this is that content being applied

        // Content applied from the device isn't sent back, even if the
        // device has sent newer content since. An image is checked first,
        // and pushed if it isn't the applied one.
        if (applied !== null) {
            if (applied.type === 'image')
                this._checkAppliedImage(applied);

            return;
        }

        this._supersedeRemoteContent(content);

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /**
     * Supersede any content still being received or applied from the device,
     * because of a local clipboard change.
     *
     * @param {object} content - The local clipboard content
     */
    _supersedeRemoteContent(content) {
        this._cancelIncomingTransfer();
        this._remoteSerial++;
        this._pendingEchoes = [];

        // Content applied from the device may be reported again, for example
        // by a clipboard manager, and is still in the clipboard. Once the
        // device has changed its clipboard since, it is sent back.
        // A received file may also be reported again once that is forgotten,
        // after reconnecting, so its directory is kept while it's in the
        // clipboard.
        if (!isSameContent(content, this._pulledContent)) {
            this._pulledContent = null;
            this._currentDir = this._getReceivedDirectory(content);
        } else if (this._remoteContent === null) {
            this._pulledContent = null;
        }
    }

    /**
     * Check if a directory holds the received file in the clipboard.
     *
     * @param {Gio.File} dir - A directory
     * @returns {boolean} %true if it holds the file in the clipboard
     */
    _isCurrentDirectory(dir) {
        return this._currentDir?.equal(dir) ?? false;
    }

    /**
     * Get the directory of a file received from the device, which a local
     * clipboard content holds.
     *
     * @param {object} content - The local clipboard content
     * @returns {Gio.File|null} The directory of the received file, or %null
     */
    _getReceivedDirectory(content) {
        let file = null;

        if (content.type === 'file')
            file = Gio.File.new_for_uri(content.uri);
        else if (content.type === 'text' && isReceivedPath(content.text))
            file = Gio.File.new_for_path(content.text);

        const dir = file?.get_parent() ?? null;
        const parent = dir?.get_parent() ?? null;

        if (parent === null || !this._getReceivePath().equal(parent))
            return null;

        return dir;
    }

    /**
     * Check that a local image change assumed to be an image applied from the
     * device is that image, and otherwise treat it as a local copy.
     *
     * @param {object} applied - The image applied from the device
     */
    async _checkAppliedImage(applied) {
        const localSerial = this._localSerial;
        const remoteSerial = this._remoteSerial;

        let image = null;
        let readFailed = false;

        try {
            image = await this._clipboard.getImage();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;

            debug(e, this.device.name);
            readFailed = true;
        }

        // Newer content from either side takes precedence. No image is
        // returned if the clipboard changed again while it was read, which
        // is reported separately.
        if (this._isSuperseded(localSerial, remoteSerial) ||
            (image === null && !readFailed))
            return;

        // An image that can't be read is not the applied one, which could be
        if (!readFailed) {
            if (image.checksum === applied.checksum)
                return;

            // Images applied in quick succession may be reported once, as the
            // last of them
            const index = this._pendingEchoes.findIndex(pending => {
                return pending.type === 'image' &&
                    pending.checksum === image.checksum;
            });

            // That image may still be reported itself, so it stays expected
            if (index !== -1) {
                this._pendingEchoes.splice(0, index);
                return;
            }
        }

        this._supersedeRemoteContent({type: 'image'});

        // Pushing was superseded along with the remote content, unless the
        // image couldn't be read for it either
        if (!readFailed && this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /**
     * Get the content applied from the device that a local clipboard change
     * reports, if any.
     *
     * @param {object} content - The local clipboard content
     * @returns {object|null} The content applied from the device, or %null if
     *   the change is a local copy
     */
    _getAppliedContent(content) {
        const index = this._findAppliedIndex(content);

        // Applied content is only reported once, so copying the same content
        // again is a new change. Content applied before it may not be
        // reported at all, if superseded before it was read.
        if (index === -1)
            return null;

        const [applied] = this._pendingEchoes.splice(0, index + 1).slice(-1);
        appliedReports.set(content, this._echoTimes.get(applied));

        return applied;
    }

    /**
     * Find the content applied from the device that a local clipboard change
     * reports, if any.
     *
     * @param {object} content - The local clipboard content
     * @returns {number} The index of the applied content, or -1
     */
    _findAppliedIndex(content) {
        this._dropExpiredEchoes();

        // Images are not read just to compare them, so the first image after
        // applying one is assumed to be it, and checked. Other content may be
        // reported once for several applied in quick succession, so the last
        // that matches is taken, which is what the clipboard holds now.
        return content.type === 'image'
            ? this._pendingEchoes.findIndex(pending => pending.type === 'image')
            : this._pendingEchoes.findLastIndex(pending => {
                return isSameContent(content, pending);
            });
    }

    /**
     * Check if a local clipboard change reports content another device
     * applied before content from this device was applied.
     *
     * @param {object} content - The local clipboard content
     * @returns {boolean} %true if the change is superseded for this device
     */
    _isSupersededElsewhere(content) {
        // Images are only assumed to be the one applied, until the plugin
        // that applied it checks, so they are not ignored on that basis
        if (content.type === 'image')
            return false;

        // The other device's plugin may have recognized the change already
        const times = [appliedReports.get(content)];

        for (const plugin of clipboardPlugins) {
            if (plugin === this)
                continue;

            const index = plugin._findAppliedIndex(content);

            if (index !== -1)
                times.push(plugin._echoTimes.get(plugin._pendingEchoes[index]));
        }

        return times.some(time => time !== undefined && time <= this._remoteTime);
    }

    /**
     * Get the content last applied from any device which is yet to be
     * reported, which the local clipboard holds once it is, since the
     * clipboard only reads it back then.
     *
     * @returns {object|null} The content last applied, or %null if none is
     *   expected
     */
    _getLastApplied() {
        let lastApplied = null;
        let lastTime = -Infinity;

        for (const plugin of clipboardPlugins) {
            plugin._dropExpiredEchoes();

            const applied = plugin._pendingEchoes.at(-1);
            const time = plugin._echoTimes.get(applied);

            if (applied !== undefined && time >= lastTime) {
                lastApplied = applied;
                lastTime = time;
            }
        }

        return lastApplied;
    }

    /**
     * Expect content applied from the device to be reported as a local
     * clipboard change.
     *
     * @param {object} content - The content being applied
     */
    _expectEcho(content) {
        this._dropExpiredEchoes();
        this._echoTimes.set(content, GLib.get_monotonic_time());
        this._pendingEchoes.push(content);

        if (this._pendingEchoes.length > MAX_PENDING_ECHOES)
            this._pendingEchoes.shift();
    }

    /**
     * Stop expecting content expected for too long, which was never reported.
     */
    _dropExpiredEchoes() {
        const now = GLib.get_monotonic_time();

        this._pendingEchoes = this._pendingEchoes.filter(pending => {
            return now - this._echoTimes.get(pending) < ECHO_TIMEOUT * 1000;
        });
    }

    /**
     * Stop expecting content to be reported, if it is still expected.
     *
     * @param {object} content - The content no longer being applied
     * @param {object|null} [replacement] - What is expected instead
     */
    _unexpectEcho(content, replacement = null) {
        const index = this._pendingEchoes.indexOf(content);

        if (index === -1)
            return;

        if (replacement !== null) {
            this._echoTimes.set(replacement, this._echoTimes.get(content));
            this._pendingEchoes[index] = replacement;
        } else {
            this._pendingEchoes.splice(index, 1);
        }
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(content) {
        if (typeof content === 'string')
            content = {type: 'text', text: content};

        // Supersede any content still being sent to the device
        this._cancelOutgoingTransfer();

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
        if (!this._serviceSettings.get_boolean('clipboard-files'))
            return false;

        if (!this.device.connected)
            return false;

        // The device must have been told that files are sent, which it is
        // when it connects
        const advertised = this.device.channel?.localIdentity?.body
            .outgoingCapabilities ?? [];

        if (!advertised.includes('kdeconnect.clipboard.file'))
            return false;

        const incoming = this.device.settings.get_strv('incoming-capabilities');
        return incoming.includes('kdeconnect.clipboard.file');
    }

    /**
     * Check if the clipboard changed on either side, or the plugin was
     * destroyed, since an operation began.
     *
     * @param {number} localSerial - The local serial when it began
     * @param {number} remoteSerial - The remote serial when it began
     * @returns {boolean} %true if the operation was superseded
     */
    _isSuperseded(localSerial, remoteSerial) {
        return localSerial !== this._localSerial ||
            remoteSerial !== this._remoteSerial ||
            this.cancellable.is_cancelled();
    }

    /**
     * Stop transferring images and files once sharing them is disabled.
     */
    _onFilesChanged() {
        if (this._serviceSettings.get_boolean('clipboard-files'))
            return;

        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();
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

        if (this._incomingCancellable !== null) {
            this._incomingCancellable.cancel();
            this._incomingCancellable = null;
        }

        if (this._applyCancellable !== null) {
            this._applyCancellable.cancel();
            this._applyCancellable = null;
            this._applyingContent = null;
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

        // Avoid reading images and files that can't be sent anyway
        const type = this._clipboard.content?.type;

        if (type !== undefined && type !== 'text' && !this._canSendFiles())
            return;

        try {
            const localSerial = this._localSerial;
            const remoteSerial = this._remoteSerial;
            const content = await this._getLocalContent();

            // Ignore content superseded by a newer clipboard change
            if (content === null ||
                this._isSuperseded(localSerial, remoteSerial))
                return;

            // Files sent before are checked for changes when sent again
            if (content.type !== 'file' &&
                isSameContent(content, this._remoteContent))
                return;

            // Don't send back content applied from the device
            if (isSameContent(content, this._pulledContent))
                return;

            // Received files placed in the clipboard as their path are not
            // sent on, like the files themselves
            if (content.type === 'text' && isReceivedPath(content.text)) {
                debug('Not forwarding the path of a received file',
                    this.device.name);
                return;
            }

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
                    await this._sendFile(content, localSerial, remoteSerial);
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

    async _sendFile(content, localSerial, remoteSerial) {
        if (!this._canSendFiles())
            return;

        const file = Gio.File.new_for_uri(content.uri);

        // Received files are not forwarded to other devices, which would see
        // them as a new file each time and send them on again
        if (isReceivedFile(file)) {
            debug(`Not forwarding a received file: ${content.uri}`,
                this.device.name);
            return;
        }

        const info = await file.query_info_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
                Gio.FILE_ATTRIBUTE_TIME_MODIFIED_USEC,
                Gio.FILE_ATTRIBUTE_TIME_CHANGED,
                Gio.FILE_ATTRIBUTE_TIME_CHANGED_USEC,
                Gio.FILE_ATTRIBUTE_UNIX_INODE,
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

        // Ignore content superseded while querying the file, or files no
        // longer shared since
        if (this._isSuperseded(localSerial, remoteSerial) ||
            !this._canSendFiles())
            return;

        // A file is only sent again if it changed since it was last sent, or
        // if that can't be told from its modification time. The inode and
        // status change time catch files replaced with their modification
        // time, although the latter also changes with the file's permissions
        // or extended attributes, and some FUSE file systems make up a new
        // inode on each lookup. Missing attributes read as 0.
        const version = info.has_attribute(Gio.FILE_ATTRIBUTE_TIME_MODIFIED)
            ? [
                info.get_size(),
                info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED),
                info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_TIME_MODIFIED_USEC),
                info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_CHANGED),
                info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_TIME_CHANGED_USEC),
                info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_UNIX_INODE),
            ].join(':')
            : null;

        if (version !== null && isSameContent(content, this._remoteContent) &&
            this._remoteContent.version === version)
            return;

        content = {...content, version};
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

        // Images and files are only applied while they're shared
        if (content.type !== 'text' &&
            !this._serviceSettings.get_boolean('clipboard-files'))
            return;

        // The content is recorded before it is applied, so the resulting
        // local clipboard change is recognized as it
        switch (content.type) {
            case 'text': {
                this._pulledContent = content;

                // Compare with the clipboard itself, which may have been
                // cleared since the text was last set, or with content
                // applied which it is yet to read back
                const current = this._getLastApplied() ??
                    this._clipboard.content;

                if (!isSameContent(current, content)) {
                    this._setAppliedTime();
                    this._localBuffer = content.text;
                    this._localTimestamp = Date.now();

                    this._expectEcho(content);
                    this._clipboard.text = content.text;
                }
                break;
            }

            case 'image':
                // Images sent to the device have no file to apply
                if (content.uri === undefined)
                    break;

                this._setAppliedTime();
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = content;
                this._applyImage(content);
                break;

            case 'file': {
                // Files sent to the device are local files, which would
                // otherwise not be sent again once changed
                if (content.version !== undefined)
                    break;

                this._setAppliedTime();
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = content;
                this._expectEcho(content);

                // The clipboard may hold the file in another form
                const applied = this._clipboard.setFile(content.uri);
                this._pulledContent = applied;
                this._unexpectEcho(content, applied);
                break;
            }
        }
    }

    /**
     * Record that content from the device is applied, which supersedes
     * content other devices applied before.
     */
    _setAppliedTime() {
        this._appliedTime = GLib.get_monotonic_time();
        this._remoteTime = this._appliedTime;
    }

    /**
     * Place a received image in the clipboard as PNG data.
     *
     * @param {object} content - A received image
     */
    async _applyImage(content) {
        const serial = this._remoteSerial;

        // The image may be pulled again while it's being applied, which is
        // left to finish
        if (this._applyCancellable !== null && this._applyingContent === content)
            return;

        // Cancelled if superseded on either side
        this._applyCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._applyCancellable = cancellable;
        this._applyingContent = content;

        try {
            // Don't replace a local image with the same image, which may have
            // come back through another device
            if (await this._isLocalImage(content))
                return;

            const bytes = await loadBytes(Gio.File.new_for_uri(content.uri),
                cancellable);

            // Ignore the image if the clipboard changed on either side in the
            // meantime
            if (this._pulledContent !== content || serial !== this._remoteSerial)
                return;

            this._expectEcho(content);
            const applied = await this._clipboard.setImage(bytes,
                content.checksum, cancellable);

            if (!applied)
                this._unexpectEcho(content);
        } catch (e) {
            this._unexpectEcho(content);

            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        } finally {
            if (this._applyCancellable === cancellable) {
                this._applyCancellable = null;
                this._applyingContent = null;
            }
        }
    }

    /**
     * Check if the local clipboard holds an image already.
     *
     * @param {object} content - An image
     * @returns {Promise<boolean>} %true if the image is in the local clipboard,
     *   or %false if it's not or the local image can't be read
     */
    async _isLocalImage(content) {
        // The local image is only read back once applied content is reported
        const applied = this._getLastApplied();

        if (applied !== null)
            return isSameContent(applied, content);

        if (this._clipboard.content?.type !== 'image')
            return false;

        try {
            const image = await this._clipboard.getImage();

            return image?.checksum === content.checksum;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;

            debug(e, this.device.name);
            return false;
        }
    }

    clearCache() {
        // Files still in the clipboard or being received are kept
        return this._cleanReceiveDirectory(this._getReceiveDirectory());
    }

    destroy() {
        clipboardPlugins.delete(this);
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();
        this._serviceSettings.disconnect(this._filesChangedId);

        if (this._clipboard && this._contentChangedId) {
            this._clipboard.disconnect(this._contentChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});

export default ClipboardPlugin;
