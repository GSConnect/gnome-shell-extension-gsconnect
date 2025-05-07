// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import '../fixtures/utils.js';

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import Config from '../config.js';
const {default: Clipboard} = await import(`file://${Config.PACKAGE_DATADIR}/service/components/clipboard.js`);


describe('The Clipboard component', function () {
    let clipboard;
    let gtkClipboard;

    beforeAll(function () {
        Gtk.init();

        const display = Gdk.Display.get_default();
        gtkClipboard = display.get_clipboard();

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
        
        let provider = Gdk.ContentProvider.new_for_value(new GLib.Variant('s', text));
        gtkClipboard.set_content(provider);
    });

    it('pushes changes to the session clipboard', async function (done) {
        const text = GLib.uuid_string_random();
    
        const id = gtkClipboard.connect('changed', async (gtkClipboard) => {
            gtkClipboard.disconnect(id);
    
            let value = await gtkClipboard.read_text_async(null);
            expect(value).toBe(text);
            done();
        });
    
        clipboard.text = text;
    });
});

