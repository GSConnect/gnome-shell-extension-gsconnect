// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
const {
    decodeImage,
    encodePng,
    getImageChecksum,
} = await import(`file://${Config.PACKAGE_DATADIR}/service/utils/image.js`);


const Component = GObject.registerClass({
    GTypeName: 'MockClipboard',
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
}, class MockClipboard extends GObject.Object {

    get content() {
        if (this._content === undefined)
            this._content = {type: 'text', text: this.text};

        return this._content;
    }

    get text() {
        if (this._text === undefined)
            this._text = 'initial';

        return this._text;
    }

    set text(content) {
        // Like the real component, the text is set even if unchanged
        if (this.text !== content) {
            this._text = content;
            this.notify('text');
        }

        this._setContent({type: 'text', text: content});
    }

    /**
     * Whether changes are reported asynchronously, like the real component.
     *
     * @type {boolean}
     */
    get async() {
        return this._async ?? false;
    }

    set async(async) {
        this._async = async;
    }

    /**
     * Whether files are placed in the clipboard as their path, like the real
     * component does with a GtkClipboard.
     *
     * @type {boolean}
     */
    get filesAsText() {
        return this._filesAsText ?? false;
    }

    set filesAsText(filesAsText) {
        this._filesAsText = filesAsText;
    }

    _setContent(content, image = null) {
        if (content.type !== 'text' && this._text !== '') {
            this._text = '';
            this.notify('text');
        }

        if (!this.async) {
            this._content = content;
            this._image = image;
            this.emit('content-changed');
            return;
        }

        // Like the real component, the content set is only read back after a
        // round trip to the session clipboard, and changes in the meantime
        // are reported once, as the last of them
        this._unreported = [content, image];

        if (this._reportId)
            return;

        this._reportId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            [this._content, this._image] = this._unreported;
            this._reportId = 0;
            this.emit('content-changed');

            return GLib.SOURCE_REMOVE;
        });
    }

    getImage() {
        return Promise.resolve(this._image);
    }

    async setImage(bytes, checksum = null, cancellable = null) {
        const pixbuf = await decodeImage(bytes, cancellable);

        if (cancellable?.is_cancelled())
            return false;

        this._setContent({type: 'image', mimetype: 'image/png'}, {
            bytes: await encodePng(pixbuf),
            checksum: await getImageChecksum(pixbuf),
        });

        return true;
    }

    setFile(uri) {
        if (this.filesAsText) {
            this.text = Gio.File.new_for_uri(uri).get_path();
            return this.content;
        }

        const content = {type: 'file', uri: uri};
        this._setContent(content);

        return content;
    }
});

export default Component;
