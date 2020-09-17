'use strict';

const {GObject} = imports.gi;


var Component = GObject.registerClass({
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
}, class MockClipboard extends GObject.Object {

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
    }
});

