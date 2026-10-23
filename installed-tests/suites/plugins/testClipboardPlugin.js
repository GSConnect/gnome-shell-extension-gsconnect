// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);


const CAPABILITIES = [
    'kdeconnect.clipboard',
    'kdeconnect.clipboard.connect',
    'kdeconnect.clipboard.file',
];


/**
 * Create a mock transfer, which copies a file to the download target.
 *
 * @param {Gio.File} source - The file to "download"
 * @returns {object} A mock transfer
 */
function mockTransfer(source) {
    return {
        _items: [],
        addFile(packet, file) {
            this._items.push(file);
        },
        start() {
            for (const file of this._items)
                source.copy(file, Gio.FileCopyFlags.OVERWRITE, null, null);

            return Promise.resolve();
        },
    };
}


/**
 * Create a clipboard file packet with a payload.
 *
 * @param {string} filename - The filename
 * @param {number} [size] - The payload size
 * @returns {object} A packet
 */
function filePacket(filename, size = 1024) {
    return new Core.Packet({
        type: 'kdeconnect.clipboard.file',
        body: {filename: filename},
        payloadSize: size,
        payloadTransferInfo: {port: 1739},
    });
}


describe('The clipboard plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: CAPABILITIES,
                outgoingCapabilities: CAPABILITIES,
            },
            remoteDevice: {
                incomingCapabilities: CAPABILITIES,
                outgoingCapabilities: CAPABILITIES,
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (remotePlugin && localPlugin) {
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin.device, 'sendPacket').and.callThrough();
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('clipboard');
        remotePlugin = testRig.remoteDevice._plugins.get('clipboard');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeTrue();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeTrue();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeTrue();
    });

    it('sends initial clipboard content when connected', async function () {
        // Prime the clipboard and simulate a new connection
        localPlugin._localBuffer = localPlugin._clipboard.text;
        localPlugin._localTimestamp = Date.now();

        localPlugin.settings.set_boolean('send-content', true);
        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.clipboard.connect');
        expect(remotePlugin._remoteContent.text).toBe('initial');

        localPlugin.settings.set_boolean('send-content', false);
    });

    it('will not push content when not allowed', function () {
        localPlugin._clipboard.text = 'foo';
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('will push content when allowed', async function () {
        localPlugin.settings.set_boolean('send-content', true);
        localPlugin._clipboard.text = 'bar';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._remoteContent.text).toBe('bar');
    });

    it('will not pull content when not allowed', async function () {
        localPlugin._clipboard.text = 'baz';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._clipboard.text).not.toBe('baz');
    });

    it('will pull content when allowed', async function () {
        remotePlugin.settings.set_boolean('receive-content', true);
        localPlugin._clipboard.text = 'qux';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._clipboard.text).toBe('qux');
    });

    it('does not push the same text twice', async function () {
        localPlugin._clipboard._setContent({type: 'text', text: 'qux'});

        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('does not push a cleared clipboard', async function () {
        localPlugin._clipboard.text = '';

        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('pushes images as PNG files', async function () {
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file');
        const [packet] = remotePlugin.handlePacket.calls.mostRecent().args;

        expect(packet.body.filename).toMatch(/^[0-9]+\.png$/);
        expect(packet.payloadSize).toBeGreaterThan(0);
    });

    it('does not push the same image twice', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));

        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        // The re-encoded image has the same pixels
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('pushes copied files', async function () {
        localPlugin._clipboard.setFile(Utils.getDataUri('vcard-valid.vcf'));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file', {
            filename: 'vcard-valid.vcf',
        });
    });

    it('pushes text after a file, even if unchanged', async function () {
        localPlugin._clipboard.text = 'qux';

        await remotePlugin.awaitPacket('kdeconnect.clipboard', {
            content: 'qux',
        });
        expect(localPlugin._remoteContent).toEqual({type: 'text', text: 'qux'});
    });

    it('does not push directories', async function () {
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        localPlugin._clipboard.setFile(
            Gio.File.new_for_path(Utils.getDataPath('album.png'))
                .get_parent().get_uri());

        // Wait for the asynchronous file query
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('does not push files to devices without support', async function () {
        const settings = localPlugin.device.settings;
        const incoming = settings.get_strv('incoming-capabilities');
        settings.set_strv('incoming-capabilities',
            incoming.filter(type => type !== 'kdeconnect.clipboard.file'));
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        localPlugin._clipboard.setFile(Utils.getDataUri('album.png'));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        settings.set_strv('incoming-capabilities', incoming);
    });

    it('ignores content that is not text', function () {
        spyOn(remotePlugin, '_onRemoteClipboardChanged');

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard.connect',
            body: {content: null, timestamp: Date.now()},
        }));

        expect(remotePlugin._onRemoteClipboardChanged).not.toHaveBeenCalled();
    });

    it('receives images into the clipboard as images', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('album.png')));
        spyOn(remotePlugin._clipboard, 'setImage').and.callThrough();
        spyOn(remotePlugin, '_applyImage').and.callThrough();
        spyOn(remotePlugin.device, 'sendPacket').and.callThrough();

        await remotePlugin._handleFile(filePacket('album.png'));
        await remotePlugin._applyImage.calls.mostRecent().returnValue;

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
        await remotePlugin._clipboard.setImage.calls.mostRecent().returnValue;
        expect(remotePlugin._clipboard.content.type).toBe('image');

        // The received image must not be sent back
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('receives other files into the clipboard as files', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin.device, 'sendPacket').and.callThrough();

        await remotePlugin._handleFile(filePacket('../../contact.vcf'));

        // The file is saved in the receive directory, with a safe name
        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        const file = Gio.File.new_for_uri(uri);
        const dir = remotePlugin._getReceiveDirectory();
        expect(file.get_basename()).toBe('contact.vcf');
        expect(file.get_parent().get_parent().equal(dir)).toBeTrue();
        expect(file.query_exists(null)).toBeTrue();

        // Previously received files are removed
        const iter = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        expect(iter.next_file(null)).not.toBeNull();
        expect(iter.next_file(null)).toBeNull();

        // The received file must not be sent back
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('cancels receiving a file superseded by text', async function () {
        const transfer = {
            addFile() {},
            start() {
                return new Promise((resolve, reject) => {
                    this.cancel = jasmine.createSpy('cancel').and.callFake(() => {
                        reject(new Gio.IOErrorEnum({
                            code: Gio.IOErrorEnum.CANCELLED,
                            message: 'Cancelled',
                        }));
                    });
                });
            },
        };
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'newer'},
        }));
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.text).toBe('newer');
    });

    it('rejects files that are too large', async function () {
        spyOn(remotePlugin.device, 'createTransfer');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('big.bin', 100 * 1024 * 1024));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('rejects files when not allowed to pull content', async function () {
        remotePlugin.settings.set_boolean('receive-content', false);
        spyOn(remotePlugin.device, 'createTransfer');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('album.png'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
        remotePlugin.settings.set_boolean('receive-content', true);
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeFalse();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeFalse();
    });
});

