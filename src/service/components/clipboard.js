// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import {decodeImage, encodePng, getImageChecksum} from '../utils/image.js';


const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';


/*
 * Mimetypes the clipboard portals are able to return as text
 */
const TEXT_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];

/*
 * Image mimetypes in order of preference; any other `image/*` type is tried
 * after these.
 */
const IMAGE_MIMETYPES = [
    'image/png',
    'image/jpeg',
    'image/bmp',
    'image/gif',
    'image/tiff',
    'image/webp',
];


/**
 * Get the local file URIs from a `text/uri-list` (RFC 2483).
 *
 * @param {string} uriList - The contents of a `text/uri-list`
 * @returns {string[]} A list of `file://` URIs
 */
function parseUriList(uriList) {
    return uriList.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .filter(uri => GLib.uri_parse_scheme(uri) === 'file');
}


/**
 * Get the preferred image mimetype from a list of mimetypes.
 *
 * @param {string[]} mimetypes - A list of mimetypes
 * @returns {string|undefined} An image mimetype, or %undefined if none
 */
function getImageMimetype(mimetypes) {
    return IMAGE_MIMETYPES.find(type => mimetypes.includes(type)) ??
        mimetypes.find(type => type.startsWith('image/') &&
            type !== 'image/svg+xml');
}


/**
 * The service class for this component
 */
const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Signals: {
        'content-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();

        this._cancellable = new Gio.Cancellable();
        this._clipboard = null;
        this._content = null;
        this._image = null;
        this._serial = 0;
        this._nameSerial = 0;

        // Incremented when the content is set, which is only reported once
        // the clipboard owner changes
        this._setSerial = 0;

        // Changes of the GtkClipboard owner caused by setting the content,
        // which are yet to be reported, and a serial for those that weren't
        this._ownSets = 0;
        this._externalSerial = 0;

        // Whether a superseded update would have emitted `content-changed`
        this._emitPending = false;

        // The last image set, to recognize it without reading it again
        this._setImage = null;

        // Images and files are only looked for when enabled
        this._settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
        });
        this._settingsChangedId = this._settings.connect(
            'changed::clipboard-files', this._onSettingsChanged.bind(this));

        this._ownerChangeId = 0;
        this._nameWatcherId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            this._onNameAppeared.bind(this),
            this._onNameVanished.bind(this)
        );
    }

    /**
     * A description of the current clipboard content, or %null if unknown.
     *
     * One of:
     * - `{type: 'text', text: string}`
     * - `{type: 'file', uri: string}`
     * - `{type: 'image', mimetype: string}`
     *
     * @type {object|null}
     */
    get content() {
        return this._content;
    }

    get text() {
        if (this._text === undefined)
            this._text = '';

        return this._text;
    }

    set text(content) {
        if (typeof content !== 'string')
            return;

        // The text is set even if unchanged, since it may not be up to date
        // with the clipboard yet
        if (this.text !== content) {
            this._text = content;
            this.notify('text');
        }

        this._setSerial++;
        this._setImage = null;

        if (this._clipboard instanceof Gtk.Clipboard) {
            this._ownSets++;
            this._clipboard.set_text(content, -1);
        }

        if (this._clipboard instanceof Gio.DBusProxy) {
            this._clipboard.call('SetText', new GLib.Variant('(s)', [content]),
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable)
                .catch(debug);
        }
    }

    _disconnectClipboard() {
        if (this._clipboard && this._ownerChangeId > 0) {
            this._clipboard.disconnect(this._ownerChangeId);
            this._ownerChangeId = 0;
        }

        if (this._signalHandler) {
            Gio.DBus.session.signal_unsubscribe(this._signalHandler);
            this._signalHandler = 0;
        }
    }

    async _onNameAppeared(connection, name, name_owner) {
        const nameSerial = ++this._nameSerial;

        try {
            // Cleanup the GtkClipboard
            this._disconnectClipboard();

            // Create a proxy for the remote clipboard
            const clipboard = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: DBUS_NAME,
                g_object_path: DBUS_PATH,
                g_interface_name: DBUS_NAME,
                g_flags: Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            });

            await clipboard.init_async(GLib.PRIORITY_DEFAULT,
                this._cancellable);

            // Ignore the proxy if the name vanished in the meantime
            if (nameSerial !== this._nameSerial)
                return;

            this._clipboard = clipboard;
            this._forgetImages();
            this._ownerChangeId = this._clipboard.connect('g-signal',
                this._onOwnerChange.bind(this));

            if (!globalThis.HAVE_GNOME) {
                // The wl-clipboard watcher emits the signal from a separate
                // connection, so subscribe to it directly
                this._signalHandler = Gio.DBus.session.signal_subscribe(
                    null,
                    DBUS_NAME,
                    'OwnerChange',
                    DBUS_PATH,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    this._onOwnerChange.bind(this)
                );
            }

            this._onOwnerChange();
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                debug(e);
                this._onNameVanished(null, null);
            }
        }
    }

    _onNameVanished(connection, name) {
        if (this._cancellable.is_cancelled())
            return;

        this._nameSerial++;

        this._disconnectClipboard();

        const display = Gdk.Display.get_default();
        this._clipboard = Gtk.Clipboard.get_default(display);
        this._forgetImages();

        this._ownSets = 0;
        this._ownerChangeId = this._clipboard.connect('owner-change',
            this._onGtkOwnerChange.bind(this));

        this._onOwnerChange();
    }

    /**
     * Forget images read or set, which are not recognized in another
     * clipboard.
     */
    _forgetImages() {
        this._image = null;
        this._setImage = null;
    }

    _onGtkOwnerChange() {
        // Each time the content is set, the owner changes once
        if (this._ownSets > 0) {
            this._ownSets--;
        } else {
            this._externalSerial++;
            this._setImage = null;
        }

        return this._onOwnerChange();
    }

    _onOwnerChange() {
        return this._update(true);
    }

    _onSettingsChanged() {
        // Content already in the clipboard is not shared because of the
        // setting changing, only when it is copied again
        return this._update(false);
    }

    /**
     * Update the content from the clipboard.
     *
     * @param {boolean} emit - Whether to emit `content-changed`
     */
    async _update(emit) {
        const serial = ++this._serial;

        // A change must still be reported if a newer update supersedes it
        this._emitPending = this._emitPending || emit;

        try {
            let content = null;

            if (this._clipboard instanceof Gtk.Clipboard)
                content = await this._gtkGetContent();
            else if (this._clipboard instanceof Gio.DBusProxy)
                content = await this._proxyGetContent();

            // Ignore the result if the clipboard changed in the meantime
            if (serial !== this._serial)
                return;

            const emitPending = this._emitPending;
            this._emitPending = false;

            this._applyUpdate(content, emitPending);
        } catch (e) {
            if (serial === this._serial)
                this._emitPending = false;

            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e);
        }
    }

    _applyUpdate(content, emit) {
        this._content = content;
        this._image = null;

        if (content?.type !== 'image')
            this._setImage = null;

        // Non-text content is reported as empty text, so setting the same text
        // again will replace it
        const text = content?.type === 'text' ? content.text : '';

        if (content !== null && this.text !== text) {
            this._text = text;
            this.notify('text');
        }

        if (content !== null && emit)
            this.emit('content-changed');
    }

    /**
     * Get the current clipboard image as PNG data.
     *
     * The result is cached until the clipboard changes, so the image is only
     * read and converted once, regardless of how many devices it is sent to.
     *
     * @returns {Promise<object|null>} An object with `bytes` (PNG data as
     *   `GLib.Bytes`) and `checksum` (see {@link getImageChecksum}), or %null
     *   if the clipboard does not contain an image
     */
    getImage() {
        if (this._content?.type !== 'image')
            return Promise.resolve(null);

        if (this._image === null) {
            const serial = this._serial;

            // Drop the result if the clipboard changed in the meantime,
            // including a failure to read an image that was replaced
            this._image = this._readImage(this._content.mimetype).then(
                image => serial === this._serial ? image : null,
                e => {
                    if (serial !== this._serial)
                        return null;

                    throw e;
                });

            this._image.catch(() => {
                if (serial === this._serial)
                    this._image = null;
            });
        }

        return this._image;
    }

    async _readImage(mimetype) {
        let pixbuf, bytes = null;

        if (this._clipboard instanceof Gtk.Clipboard) {
            // Don't read back an image that was just set, which would block
            // until it is converted to the requested format
            if (this._setImage !== null)
                return this._setImage;

            // The data is read and decoded separately, to limit the size of
            // the image and avoid decoding it in the main thread
            const data = await new Promise((resolve, reject) => {
                this._clipboard.request_contents(Gdk.Atom.intern(mimetype,
                    false), (clipboard, selection) => {
                    resolve(selection?.get_data() ?? null);
                });
            });

            if (data === null || data.length === 0)
                throw new Error('Clipboard image not available');

            bytes = new GLib.Bytes(data);
            pixbuf = await decodeImage(bytes, this._cancellable);
        } else if (this._clipboard instanceof Gio.DBusProxy) {
            bytes = await this._proxyGetValue(this._clipboard, mimetype);

            // Don't decode an image that was just set again
            if (mimetype === 'image/png' && this._setImage?.bytes.equal(bytes)) {
                const image = this._setImage;
                this._setImage = null;

                return image;
            }

            pixbuf = await decodeImage(bytes, this._cancellable);
        } else {
            throw new Error('No clipboard available');
        }

        // Send PNG data as-is, otherwise convert it to PNG
        if (mimetype !== 'image/png')
            bytes = await encodePng(pixbuf, this._cancellable);

        return {
            bytes: bytes,
            checksum: await getImageChecksum(pixbuf, this._cancellable),
        };
    }

    /**
     * Set the clipboard content to an image.
     *
     * @param {GLib.Bytes} bytes - PNG data
     * @param {string} [checksum] - The checksum of the image, if known (see
     *   {@link getImageChecksum})
     * @param {Gio.Cancellable} [cancellable] - Cancelled if the image is
     *   superseded before it is set
     * @returns {Promise<boolean>} %true if the image was set, or %false if the
     *   clipboard changed or it was cancelled before it could be
     */
    async setImage(bytes, checksum = null, cancellable = null) {
        // The image in the clipboard is still recognized until this one
        // replaces it
        const setSerial = ++this._setSerial;

        if (this._clipboard instanceof Gtk.Clipboard) {
            const clipboard = this._clipboard;
            const externalSerial = this._externalSerial;
            const pixbuf = await decodeImage(bytes,
                cancellable ?? this._cancellable);

            // Don't replace content copied elsewhere or set while decoding
            if (this._clipboard !== clipboard ||
                externalSerial !== this._externalSerial ||
                setSerial !== this._setSerial ||
                cancellable?.is_cancelled() ||
                this._cancellable.is_cancelled())
                return false;

            // The image is recognized without reading it back
            this._setImage = checksum !== null ? {bytes, checksum} : null;

            this._ownSets++;
            clipboard.set_image(pixbuf);
            return true;
        } else if (this._clipboard instanceof Gio.DBusProxy) {
            // The image is read back as the same data, so it is recognized
            // without decoding it again
            this._setImage = checksum !== null ? {bytes, checksum} : null;

            await this._clipboard.call('SetValue',
                this._createValue(bytes, 'image/png'),
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
            return true;
        }

        return false;
    }

    /**
     * Set the clipboard content to a file.
     *
     * The GtkClipboard can not offer a file list from GJS, so the file path is
     * offered as text in that case.
     *
     * @param {string} uri - A `file://` URI
     * @returns {object|null} The content placed in the clipboard (see
     *   {@link Clipboard.content}), or %null if no clipboard is available
     */
    setFile(uri) {
        this._setSerial++;
        this._setImage = null;

        if (this._clipboard instanceof Gtk.Clipboard) {
            const path = Gio.File.new_for_uri(uri).get_path();
            this._ownSets++;
            this._clipboard.set_text(path, -1);

            return {type: 'text', text: path};
        } else if (this._clipboard instanceof Gio.DBusProxy) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(`${uri}\r\n`));
            this._proxySetValue(bytes, 'text/uri-list');

            return {type: 'file', uri: uri};
        }

        return null;
    }

    /*
     * Proxy Clipboard
     */
    async _proxyGetValue(proxy, mimetype) {
        const reply = await proxy.call('GetValue',
            new GLib.Variant('(s)', [mimetype]),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);

        return reply.get_child_value(0).get_data_as_bytes();
    }

    _createValue(bytes, mimetype) {
        return GLib.Variant.new_tuple([
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
            GLib.Variant.new_string(mimetype),
        ]);
    }

    _proxySetValue(bytes, mimetype) {
        this._clipboard.call('SetValue', this._createValue(bytes, mimetype),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable)
            .catch(debug);
    }

    async _proxyGetContent() {
        // Keep using the same proxy, even if it's replaced in the meantime
        const proxy = this._clipboard;

        let reply = await proxy.call('GetMimetypes', null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
        const mimetypes = reply.deepUnpack()[0];

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return {type: 'text', text: ''};

        const filesEnabled = this._settings.get_boolean('clipboard-files');

        // Copied files are ignored, unless sharing them is enabled
        if (mimetypes.includes('text/uri-list')) {
            if (!filesEnabled)
                return null;

            const bytes = await this._proxyGetValue(proxy, 'text/uri-list');
            const uris = parseUriList(new TextDecoder().decode(bytes.toArray()));
            const [uri] = uris;

            if (uris.length > 1)
                debug(`Only sharing the first of ${uris.length} copied files`);

            if (uri !== undefined)
                return {type: 'file', uri: uri};
        }

        // Only request text if it's available, to avoid needless transfers
        if (TEXT_MIMETYPES.some(type => mimetypes.includes(type))) {
            reply = await proxy.call('GetText', null,
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);

            return {type: 'text', text: reply.deepUnpack()[0]};
        }

        // Images are only read on demand, by getImage()
        const mimetype = getImageMimetype(mimetypes);

        if (filesEnabled && mimetype !== undefined)
            return {type: 'image', mimetype: mimetype};

        return null;
    }

    /*
     * GtkClipboard
     */
    async _gtkGetContent() {
        const mimetypes = await new Promise((resolve, reject) => {
            this._clipboard.request_targets((clipboard, atoms) => {
                resolve(atoms ?? []);
            });
        });

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return {type: 'text', text: ''};

        const filesEnabled = this._settings.get_boolean('clipboard-files');

        // Copied files are ignored, unless sharing them is enabled
        if (Gtk.targets_include_uri(mimetypes)) {
            if (!filesEnabled)
                return null;

            const uris = await new Promise((resolve, reject) => {
                this._clipboard.request_uris((clipboard, uris) => {
                    resolve(uris ?? []);
                });
            });
            const files = uris.filter(u => GLib.uri_parse_scheme(u) === 'file');
            const [uri] = files;

            if (files.length > 1)
                debug(`Only sharing the first of ${files.length} copied files`);

            if (uri !== undefined)
                return {type: 'file', uri: uri};
        }

        if (Gtk.targets_include_text(mimetypes)) {
            const text = await new Promise((resolve, reject) => {
                this._clipboard.request_text((clipboard, text) => resolve(text));
            });

            if (typeof text === 'string')
                return {type: 'text', text: text};
        }

        // Images are only read on demand, by getImage()
        if (filesEnabled && Gtk.targets_include_image(mimetypes, false)) {
            const mimetype = getImageMimetype(mimetypes) ?? 'image/png';
            return {type: 'image', mimetype: mimetype};
        }

        return null;
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();
        this._disconnectClipboard();

        if (this._settingsChangedId > 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }
    }
});

export default Clipboard;

// vim:tabstop=2:shiftwidth=2:expandtab
