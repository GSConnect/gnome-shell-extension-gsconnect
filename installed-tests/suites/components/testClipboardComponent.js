// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import '../fixtures/utils.js';

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import Config from '../config.js';
const {default: Clipboard} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/components/clipboard.js`
);


describe('The Clipboard component', function () {
    let clipboard;
    let gdkClipboard;

    const readText = () => new Promise((resolve, reject) => {
        gdkClipboard.read_text_async(null, (source, res) => {
            try {
                resolve(source.read_text_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });

    beforeAll(function () {
        Gtk.init();

        gdkClipboard = Gdk.Display.get_default().get_clipboard();

        clipboard = new Clipboard();
    });

    afterAll(function () {
        clipboard.destroy();
    });

    it('pulls changes from the session clipboard', function (done) {
        const text = GLib.uuid_string_random();

        const id = clipboard.connect('notify::text', (clipboard) => {
            clipboard.disconnect(id);

            expect(clipboard.text).toBe(text);
            done();
        });

        gdkClipboard.set_content(Gdk.ContentProvider.new_for_value(text));
    });

    it('pushes changes to the session clipboard', async function () {
        const text = GLib.uuid_string_random();

        clipboard.text = text;

        expect(await readText()).toBe(text);
    });
});
