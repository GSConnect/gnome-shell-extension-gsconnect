// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import Config from '../config.js';
const {default: Clipboard} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/components/clipboard.js`
);


// Image data is decoded in the runtime directory, which must not be that of
// a running service
let tmpdir;

beforeAll(function () {
    tmpdir = Utils.isolateDirectories();
});

afterAll(function () {
    Utils.removeDirectory(tmpdir);
});


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


describe('The Clipboard component with a clipboard portal', function () {
    const PNG = GLib.file_get_contents(Utils.getDataPath('album.png'));
    let clipboard, portal;

    /**
     * Create a stand-in for the clipboard portal proxy, which records calls.
     *
     * @param {object} values - Clipboard content by mimetype
     * @returns {Gio.DBusProxy} A proxy
     */
    function mockPortal(values) {
        const proxy = new Gio.DBusProxy({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.gnome.Shell.Extensions.GSConnect.Clipboard',
            g_object_path: '/org/gnome/Shell/Extensions/GSConnect/Clipboard',
            g_interface_name: 'org.gnome.Shell.Extensions.GSConnect.Clipboard',
        });
        proxy.calls = [];
        proxy.call = (method, params) => {
            proxy.calls.push(method);

            switch (method) {
                case 'GetMimetypes':
                    return Promise.resolve(new GLib.Variant('(as)',
                        [Object.keys(values)]));

                case 'GetText':
                    return Promise.resolve(new GLib.Variant('(s)',
                        [values['text/plain;charset=utf-8']]));

                case 'GetValue': {
                    const [mimetype] = params.deepUnpack();
                    return Promise.resolve(new GLib.Variant('(ay)',
                        [values[mimetype]]));
                }

                case 'SetText':
                case 'SetValue':
                    return Promise.resolve(null);
            }

            return Promise.reject(new Error(`Unexpected call: ${method}`));
        };

        return proxy;
    }

    beforeAll(async function () {
        clipboard = new Clipboard();

        // Let the component settle on a clipboard, then stop watching it so
        // only the calls made by each test are recorded
        await Utils.waitFor(() => clipboard._ownerChangeId > 0);
        clipboard._disconnectClipboard();
    });

    afterAll(function () {
        clipboard._settings.set_boolean('clipboard-files', false);
        clipboard.destroy();
    });

    beforeEach(function () {
        clipboard._settings.set_boolean('clipboard-files', false);
    });

    it('only reads the mimetypes of images when sharing them is disabled', async function () {
        portal = mockPortal({'image/png': PNG[1]});
        clipboard._clipboard = portal;

        await clipboard._onOwnerChange();

        expect(clipboard.content).toBeNull();
        expect(portal.calls).toEqual(['GetMimetypes']);
    });

    it('only reads the mimetypes of files when sharing them is disabled', async function () {
        portal = mockPortal({
            'text/uri-list': new TextEncoder().encode('file:///tmp/file\r\n'),
            'text/plain;charset=utf-8': '/tmp/file',
        });
        clipboard._clipboard = portal;

        await clipboard._onOwnerChange();

        expect(clipboard.content).toBeNull();
        expect(portal.calls).toEqual(['GetMimetypes']);
    });

    it('doesn\'t request text if none is offered', async function () {
        clipboard._settings.set_boolean('clipboard-files', true);
        portal = mockPortal({'image/png': PNG[1]});
        clipboard._clipboard = portal;

        await clipboard._onOwnerChange();

        expect(clipboard.content).toEqual({type: 'image', mimetype: 'image/png'});
        expect(portal.calls).toEqual(['GetMimetypes']);
    });

    it('reads an image once, when requested', async function () {
        clipboard._settings.set_boolean('clipboard-files', true);
        portal = mockPortal({'image/png': PNG[1]});
        clipboard._clipboard = portal;

        await clipboard._onOwnerChange();
        const image = await clipboard.getImage();
        await clipboard.getImage();

        expect(image.bytes.get_size()).toBe(PNG[1].length);
        expect(portal.calls).toEqual(['GetMimetypes', 'GetValue']);
    });

    it('detects copied files when sharing them is enabled', async function () {
        clipboard._settings.set_boolean('clipboard-files', true);
        portal = mockPortal({
            'text/uri-list': new TextEncoder().encode('# comment\r\nfile:///tmp/file\r\n'),
            'text/plain;charset=utf-8': '/tmp/file',
        });
        clipboard._clipboard = portal;

        await clipboard._onOwnerChange();

        expect(clipboard.content).toEqual({type: 'file', uri: 'file:///tmp/file'});
    });

    it('doesn\'t share content already copied when enabling sharing', async function () {
        portal = mockPortal({'image/png': PNG[1]});
        clipboard._clipboard = portal;
        await clipboard._onOwnerChange();

        const changed = jasmine.createSpy('content-changed');
        const id = clipboard.connect('content-changed', changed);

        clipboard._settings.set_boolean('clipboard-files', true);
        await clipboard._onSettingsChanged();
        clipboard.disconnect(id);

        expect(clipboard.content).toEqual({type: 'image', mimetype: 'image/png'});
        expect(changed).not.toHaveBeenCalled();
    });

    it('still reports a change superseded by enabling sharing', async function () {
        portal = mockPortal({'text/plain;charset=utf-8': 'superseded'});
        clipboard._clipboard = portal;

        const changed = jasmine.createSpy('content-changed');
        const id = clipboard.connect('content-changed', changed);

        const ownerChange = clipboard._onOwnerChange();
        const settingsChange = clipboard._onSettingsChanged();
        await Promise.all([ownerChange, settingsChange]);
        clipboard.disconnect(id);

        expect(clipboard.content).toEqual({type: 'text', text: 'superseded'});
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('recognizes an image it set without decoding it', async function () {
        clipboard._settings.set_boolean('clipboard-files', true);
        portal = mockPortal({'image/png': PNG[1]});
        clipboard._clipboard = portal;

        expect(await clipboard.setImage(new GLib.Bytes(PNG[1]),
            'known-checksum')).toBeTrue();
        await clipboard._onOwnerChange();
        const image = await clipboard.getImage();

        expect(image.checksum).toBe('known-checksum');
    });

    it('doesn\'t set an image if copied elsewhere while decoding', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        clipboard._ownSets = 0;
        spyOn(clipboard._clipboard, 'set_image');

        // Another application takes the clipboard
        const result = clipboard.setImage(new GLib.Bytes(PNG[1]));
        clipboard._onGtkOwnerChange();

        expect(await result).toBeFalse();
        expect(clipboard._clipboard.set_image).not.toHaveBeenCalled();
    });

    it('sets an image if only its own change is reported while decoding', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        clipboard._ownSets = 0;
        spyOn(clipboard._clipboard, 'set_text');
        spyOn(clipboard._clipboard, 'set_image');

        // Text set before the image is reported while it is decoding
        clipboard.text = 'set before the image';
        const result = clipboard.setImage(new GLib.Bytes(PNG[1]));
        clipboard._onGtkOwnerChange();

        expect(await result).toBeTrue();
        expect(clipboard._clipboard.set_image).toHaveBeenCalled();
    });

    it('doesn\'t set an image that was cancelled while decoding', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        spyOn(clipboard._clipboard, 'set_image');

        const cancellable = new Gio.Cancellable();
        const result = clipboard.setImage(new GLib.Bytes(PNG[1]), null,
            cancellable);
        cancellable.cancel();

        await expectAsync(result).toBeRejected();
        expect(clipboard._clipboard.set_image).not.toHaveBeenCalled();
    });

    it('sets text even if it seems unchanged', function () {
        portal = mockPortal({});
        clipboard._clipboard = portal;
        clipboard._text = 'unchanged';

        clipboard.text = 'unchanged';

        expect(portal.calls).toEqual(['SetText']);
    });

    it('doesn\'t set an image if text is set while decoding', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        spyOn(clipboard._clipboard, 'set_image');
        spyOn(clipboard._clipboard, 'set_text');

        const result = clipboard.setImage(new GLib.Bytes(PNG[1]), 'checksum');
        clipboard.text = 'set while decoding';

        expect(await result).toBeFalse();
        expect(clipboard._clipboard.set_image).not.toHaveBeenCalled();

        // An image that wasn't set isn't recognized as the one in the clipboard
        expect(clipboard._setImage).toBeNull();
    });

    it('recognizes an image it set without reading it back', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        clipboard._ownSets = 0;
        spyOn(clipboard._clipboard, 'set_image');
        spyOn(clipboard._clipboard, 'request_contents');

        expect(await clipboard.setImage(new GLib.Bytes(PNG[1]),
            'set-checksum')).toBeTrue();
        clipboard._applyUpdate({type: 'image', mimetype: 'image/png'}, false);
        const image = await clipboard.getImage();

        expect(image.checksum).toBe('set-checksum');
        expect(clipboard._clipboard.request_contents).not.toHaveBeenCalled();

        // Until another application takes the clipboard
        clipboard._ownSets = 0;
        spyOn(clipboard, '_update');
        clipboard._onGtkOwnerChange();

        expect(clipboard._setImage).toBeNull();
    });

    it('recognizes an image it set until another replaces it', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        clipboard._ownSets = 0;
        spyOn(clipboard._clipboard, 'set_image');
        spyOn(clipboard._clipboard, 'request_contents');

        await clipboard.setImage(new GLib.Bytes(PNG[1]), 'first');
        clipboard._applyUpdate({type: 'image', mimetype: 'image/png'}, false);

        // Setting another image is cancelled while it is decoded
        const cancellable = new Gio.Cancellable();
        const result = clipboard.setImage(new GLib.Bytes(PNG[1]), 'second',
            cancellable);
        expect((await clipboard.getImage()).checksum).toBe('first');

        cancellable.cancel();
        await expectAsync(result).toBeRejected();
        clipboard._applyUpdate({type: 'image', mimetype: 'image/png'}, false);

        expect((await clipboard.getImage()).checksum).toBe('first');
        expect(clipboard._clipboard.request_contents).not.toHaveBeenCalled();
    });

    it('forgets images when the clipboard is replaced', function () {
        clipboard._setImage = {bytes: new GLib.Bytes(PNG[1]), checksum: 'old'};
        clipboard._image = Promise.resolve(clipboard._setImage);
        spyOn(clipboard, '_onOwnerChange');

        // The clipboard portal goes away, for example when GNOME Shell restarts
        clipboard._onNameVanished(null, null);
        clipboard._disconnectClipboard();

        expect(clipboard._setImage).toBeNull();
        expect(clipboard._image).toBeNull();
    });

    it('forgets images when the clipboard portal appears', async function () {
        clipboard._setImage = {bytes: new GLib.Bytes(PNG[1]), checksum: 'old'};
        clipboard._image = Promise.resolve(clipboard._setImage);
        spyOn(clipboard, '_onOwnerChange');
        spyOn(Gio.DBusProxy.prototype, 'init_async').and.resolveTo(true);

        // GNOME Shell starts exporting its clipboard
        await clipboard._onNameAppeared(null, null, null);
        clipboard._disconnectClipboard();

        expect(clipboard._setImage).toBeNull();
        expect(clipboard._image).toBeNull();

        // The proxy isn't connected, so later tests must not call it
        clipboard._clipboard = null;
    });

    it('drops an image read when the clipboard changes meanwhile', async function () {
        clipboard._settings.set_boolean('clipboard-files', true);

        for (const fail of [false, true]) {
            portal = mockPortal({'image/png': PNG[1]});
            clipboard._clipboard = portal;
            await clipboard._onOwnerChange();

            // The image is replaced by text while it is read
            let finish;
            const call = portal.call;
            portal.call = (method, params) => {
                if (method !== 'GetValue')
                    return call(method, params);

                return new Promise((resolve, reject) => {
                    finish = () => fail
                        ? reject(new Error('image/png not available'))
                        : resolve(call(method, params));
                });
            };

            const image = clipboard.getImage();
            await Promise.idle(GLib.PRIORITY_DEFAULT);
            portal.call = call;
            clipboard._clipboard = mockPortal({
                'text/plain;charset=utf-8': 'replaced',
            });
            await clipboard._onOwnerChange();
            finish();

            expect(await image).toBeNull();
        }
    });

    it('doesn\'t decode a copied image with too many pixels', async function () {
        const display = Gdk.Display.get_default();
        clipboard._clipboard = Gtk.Clipboard.get_default(display);
        clipboard._setImage = null;
        spyOn(clipboard._clipboard, 'request_contents').and.callFake(
            (target, callback) => {
                callback(clipboard._clipboard, {
                    get_data: () => Utils.createHugePng(20000, 20000),
                });
            });

        clipboard._applyUpdate({type: 'image', mimetype: 'image/png'}, false);

        await expectAsync(clipboard.getImage()).toBeRejectedWithError(
            /too large/);
    });
});
