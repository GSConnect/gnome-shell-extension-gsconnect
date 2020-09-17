'use strict';

const Utils = imports.fixtures.utils;

const {Gdk, Gtk, Gio, GLib} = imports.gi;

const {Clipboard} = imports.service.components.clipboard;


describe('The Clipboard component', function () {
    let clipboard;
    let gtkClipboard;

    beforeAll(function () {
        Gtk.init(null);

        const display = Gdk.Display.get_default();
        gtkClipboard = Gtk.Clipboard.get_default(display);

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

        gtkClipboard.set_text(text, -1);
    });

    it('pushes changes to the session clipboard', function (done) {
        const text = GLib.uuid_string_random();

        const id = gtkClipboard.connect('owner-change', (gtkClipboard) => {
            gtkClipboard.disconnect(id);

            expect(gtkClipboard.wait_for_text()).toBe(text);
            done();
        });

        clipboard.text = text;
    });
});

