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

    it('pulls changes from the session clipboard', async function () {
        const text = GLib.uuid_string_random();

        const promise = new Promise((resolve) => {
            const id = clipboard.connect('notify::text', (clipboard) => {
                if (clipboard.text === text) {
                    clipboard.disconnect(id);
                    resolve();
                }
            });
        });

        const provider = Gdk.ContentProvider.new_for_value(text);
        gtkClipboard.set_content(provider);

        await promise;
        expect(clipboard.text).toBe(text);
    });

    it('pushes changes to the session clipboard', async function () {
        const text = GLib.uuid_string_random();

        const promise = new Promise((resolve) => {
            const id = gtkClipboard.connect('changed', async (gtkClipboard) => {
                const value = await new Promise((resolve) => {
                    gtkClipboard.read_text_async(null, (source, res) => {
                        resolve(source.read_text_finish(res));
                    });
                });

                if (value === text) {
                    gtkClipboard.disconnect(id);
                    resolve();
                }
            });
        });

        clipboard.text = text;

        await promise;
        const value = await new Promise((resolve) => {
            gtkClipboard.read_text_async(null, (source, res) => {
                resolve(source.read_text_finish(res));
            });
        });
        expect(value).toBe(text);
    });
});
