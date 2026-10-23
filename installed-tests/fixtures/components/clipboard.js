// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

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
        if (this.text === content)
            return;

        this._text = content;
        this.notify('text');
        this._setContent({type: 'text', text: content});
    }

    _setContent(content, image = null) {
        this._content = content;
        this._image = image;

        if (content.type !== 'text' && this._text !== '') {
            this._text = '';
            this.notify('text');
        }

        this.emit('content-changed');
    }

    getImage() {
        return Promise.resolve(this._image);
    }

    async setImage(bytes) {
        const pixbuf = await decodeImage(bytes);

        this._setContent({type: 'image', mimetype: 'image/png'}, {
            bytes: await encodePng(pixbuf),
            checksum: getImageChecksum(pixbuf),
        });
    }

    setFile(uri) {
        const content = {type: 'file', uri: uri};
        this._setContent(content);

        return content;
    }
});

export default Component;
