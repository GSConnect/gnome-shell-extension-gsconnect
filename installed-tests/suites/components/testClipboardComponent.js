import '../fixtures/utils.js';

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import Config from '../config.js';
const {default: Clipboard} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/components/clipboard.js`
);

/* Mock GTK Clipboard */
const MockGtkClipboard = GObject.registerClass({
    Signals: {
        changed: {},
    },
}, class MockGtkClipboard extends GObject.Object {
    _text = null;

    set_content(provider) {
        this._text = provider.get_value().get_string()[0];
        this.emit('changed');
    }

    async read_text_async() {
        return await new Promise((resolve) => {
            // simulate async delay in next main loop iteration
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                resolve(this._text);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
});


describe('The Clipboard component', function () {
    let clipboard;
    let gtkClipboard;

    beforeAll(function () {
        gtkClipboard = new MockGtkClipboard();
        clipboard = new Clipboard(gtkClipboard);
    });

    afterAll(function () {
        clipboard.destroy();
    });

    it('pulls changes from the session clipboard', function (done) {
        const text = GLib.uuid_string_random();

        clipboard.connect('notify::text', () => {
            expect(clipboard.text).toBe(text);
            done();
        });

        gtkClipboard.set_content({
            get_value: () => new GLib.Variant('s', text),
        });
    });

    it('pushes changes to clipboard', async function () {
        const text = GLib.uuid_string_random();
        clipboard.text = text;

        const value = await gtkClipboard.read_text_async(null);
        expect(value).toBe(text);
    });
});
