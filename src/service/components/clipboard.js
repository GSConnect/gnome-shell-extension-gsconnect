// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

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
        if (this.text === content)
            return;

        this._text = content;
        this.notify('text');

        if (typeof content !== 'string')
            return;

        if (this._clipboard instanceof Gtk.Clipboard)
            this._clipboard.set_text(content, -1);

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

        this._ownerChangeId = this._clipboard.connect('owner-change',
            this._onOwnerChange.bind(this));

        this._onOwnerChange();
    }

    async _onOwnerChange() {
        const serial = ++this._serial;

        try {
            let content = null;

            if (this._clipboard instanceof Gtk.Clipboard)
                content = await this._gtkGetContent();
            else if (this._clipboard instanceof Gio.DBusProxy)
                content = await this._proxyGetContent();

            // Ignore the result if the clipboard changed in the meantime
            if (serial !== this._serial)
                return;

            this._applyUpdate(content);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e);
        }
    }

    _applyUpdate(content) {
        this._content = content;
        this._image = null;

        // Non-text content is reported as empty text, so setting the same text
        // again will replace it
        const text = content?.type === 'text' ? content.text : '';

        if (content !== null && this.text !== text) {
            this._text = text;
            this.notify('text');
        }

        if (content !== null)
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

            this._image = this._readImage(this._content.mimetype).then(image => {
                // Drop the result if the clipboard changed in the meantime
                if (serial !== this._serial)
                    return null;

                return image;
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
            pixbuf = await new Promise((resolve, reject) => {
                this._clipboard.request_image((clipboard, image) => {
                    resolve(image);
                });
            });

            if (pixbuf === null)
                throw new Error('Clipboard image not available');
        } else if (this._clipboard instanceof Gio.DBusProxy) {
            bytes = await this._proxyGetValue(mimetype);
            pixbuf = await decodeImage(bytes, this._cancellable);
        } else {
            throw new Error('No clipboard available');
        }

        // Send PNG data as-is, otherwise convert it to PNG
        if (mimetype !== 'image/png' || bytes === null)
            bytes = await encodePng(pixbuf, this._cancellable);

        return {
            bytes: bytes,
            checksum: getImageChecksum(pixbuf),
        };
    }

    /**
     * Set the clipboard content to an image.
     *
     * @param {GLib.Bytes} bytes - PNG data
     */
    setImage(bytes) {
        if (this._clipboard instanceof Gtk.Clipboard) {
            const clipboard = this._clipboard;

            decodeImage(bytes, this._cancellable).then(pixbuf => {
                if (this._clipboard === clipboard)
                    clipboard.set_image(pixbuf);
            }).catch(debug);
        } else if (this._clipboard instanceof Gio.DBusProxy) {
            this._proxySetValue(bytes, 'image/png');
        }
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
        if (this._clipboard instanceof Gtk.Clipboard) {
            const path = Gio.File.new_for_uri(uri).get_path();
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
    async _proxyGetValue(mimetype) {
        const reply = await this._clipboard.call('GetValue',
            new GLib.Variant('(s)', [mimetype]),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);

        return reply.get_child_value(0).get_data_as_bytes();
    }

    _proxySetValue(bytes, mimetype) {
        const parameters = GLib.Variant.new_tuple([
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
            GLib.Variant.new_string(mimetype),
        ]);

        this._clipboard.call('SetValue', parameters,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable)
            .catch(debug);
    }

    async _proxyGetContent() {
        let reply = await this._clipboard.call('GetMimetypes', null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
        const mimetypes = reply.deepUnpack()[0];

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return {type: 'text', text: ''};

        // Copied files
        if (mimetypes.includes('text/uri-list')) {
            const bytes = await this._proxyGetValue('text/uri-list');
            const [uri] = parseUriList(new TextDecoder().decode(bytes.toArray()));

            if (uri !== undefined)
                return {type: 'file', uri: uri};
        }

        // Only request text if it's available, to avoid needless transfers
        if (TEXT_MIMETYPES.some(type => mimetypes.includes(type))) {
            reply = await this._clipboard.call('GetText', null,
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);

            return {type: 'text', text: reply.deepUnpack()[0]};
        }

        // Images are only read on demand, by getImage()
        const mimetype = getImageMimetype(mimetypes);

        if (mimetype !== undefined)
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

        // Copied files
        if (Gtk.targets_include_uri(mimetypes)) {
            const uris = await new Promise((resolve, reject) => {
                this._clipboard.request_uris((clipboard, uris) => {
                    resolve(uris ?? []);
                });
            });
            const uri = uris.find(u => GLib.uri_parse_scheme(u) === 'file');

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
        if (Gtk.targets_include_image(mimetypes, false)) {
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

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }
    }
});

export default Clipboard;

// vim:tabstop=2:shiftwidth=2:expandtab
