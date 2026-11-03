// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const {MAX_FILE_SIZE, decodeImage, getImageChecksum} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/utils/image.js`);


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
 * Create a mock transfer, which receives part of a file and doesn't complete
 * until cancelled.
 *
 * @returns {object} A mock transfer
 */
function pendingTransfer() {
    return {
        addFile(packet, file) {
            this.file = file;
        },
        start(cancellable) {
            this.file?.replace_contents('partial', null, false,
                Gio.FileCreateFlags.NONE, null);

            return new Promise((resolve, reject) => {
                this.cancel = jasmine.createSpy('cancel').and.callFake(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled',
                    }));
                });

                // Like a real transfer, follow the cancellable passed in
                cancellable?.connect(() => this.cancel());
            });
        },
    };
}


/**
 * Set whether images and files are shared, and tell the devices of plugins, as
 * they are when they reconnect.
 *
 * @param {boolean} enabled - Whether images and files are shared
 * @param {...object} plugins - Clipboard plugins
 */
function shareFiles(enabled, ...plugins) {
    plugins[0]._serviceSettings.set_boolean('clipboard-files', enabled);

    // The identity of the service, which the mock backend's lacks
    const service = new Core.ChannelService({id: 'test', name: 'test'});
    service.buildIdentity();

    // Like a channel connected since, which records the identity it sent
    for (const plugin of plugins)
        plugin.device.channel._localIdentity = service.identity;
}


/**
 * List the names of the children of a directory.
 *
 * @param {Gio.File} dir - A directory
 * @returns {string[]} The names of the children
 */
function listChildren(dir) {
    const names = [];
    const iter = dir.enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);

    let info;
    while ((info = iter.next_file(null)) !== null)
        names.push(info.get_name());

    iter.close(null);
    return names;
}


/**
 * Write a file in a new directory, within the isolated test directories.
 *
 * @param {string} name - The file name
 * @param {function(string)} write - Writes the file at a path
 * @returns {Gio.File} The file
 */
function tempFile(name, write) {
    const dir = GLib.build_filenamev([
        Config.CONFIGDIR,
        GLib.uuid_string_random(),
    ]);
    GLib.mkdir_with_parents(dir, 448);

    const path = GLib.build_filenamev([dir, name]);
    write(path);

    return Gio.File.new_for_path(path);
}


/**
 * Create a mock transfer, which writes a file larger than allowed to the
 * download target, regardless of the size declared in the packet.
 *
 * @param {boolean} pending - Whether the transfer continues until cancelled
 * @returns {object} A mock transfer
 */
function oversizedTransfer(pending) {
    return {
        addFile(packet, file) {
            this.file = file;
        },
        start(cancellable) {
            const stream = this.file.replace(null, false,
                Gio.FileCreateFlags.NONE, null);
            stream.seek(MAX_FILE_SIZE, GLib.SeekType.SET, null);
            stream.write_bytes(new GLib.Bytes([0]), null);
            stream.close(null);

            if (!pending)
                return Promise.resolve();

            return new Promise((resolve, reject) => {
                this.cancel = () => {
                    this.cancelled = true;
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled',
                    }));
                };

                cancellable.connect(() => this.cancel());
            });
        },
        cancel() {},
    };
}


/**
 * Watch for content sent to the device, without sending images and files.
 *
 * @param {object} plugin - A clipboard plugin
 */
function watchPushes(plugin) {
    spyOn(plugin, 'clipboardPush').and.callThrough();
    spyOn(plugin, '_sendImage').and.resolveTo();
    spyOn(plugin, '_sendFile').and.resolveTo();
    spyOn(plugin.device, 'sendPacket').and.callThrough();
}


/**
 * Check that the clipboard content was not sent to the device, once it was
 * reported, which only pushes it if it's taken for a local copy.
 *
 * @param {object} plugin - A clipboard plugin watched with watchPushes()
 */
async function expectNotSentBack(plugin) {
    await Utils.waitFor(() => plugin._pendingEchoes.length === 0 ||
        plugin.clipboardPush.calls.count() > 0);

    // Let an applied image be checked, which pushes it if it isn't the one
    await new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
    await Promise.all(plugin.clipboardPush.calls.all()
        .map(call => call.returnValue));

    expect(plugin._sendImage).not.toHaveBeenCalled();
    expect(plugin._sendFile).not.toHaveBeenCalled();
    expect(plugin.device.sendPacket).not.toHaveBeenCalled();
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


/**
 * Create pseudo-random data.
 *
 * @param {number} length - The length
 * @returns {Uint8Array} The data
 */
function noise(length) {
    const data = new Uint8Array(length);
    let state = 1;

    for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        data[i] = state >> 16;
    }

    return data;
}


/**
 * Compute the expected checksum of pixel data without padding, which is the
 * SHA-256 of the digests of each 4 MiB of it.
 *
 * @param {string} dimensions - The dimensions, as `WxHxC`
 * @param {Uint8Array} data - Pixel data without padding
 * @returns {string} The checksum
 */
function referenceChecksum(dimensions, data) {
    const chunkSize = 4 * 1024 * 1024;
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);

    for (let offset = 0; offset < data.length; offset += chunkSize) {
        checksum.update(new TextEncoder().encode(GLib.compute_checksum_for_data(
            GLib.ChecksumType.SHA256,
            data.subarray(offset, offset + chunkSize))));
    }

    return `${dimensions}:${checksum.get_string()}`;
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

            // Transfers are faked, so there is nothing to reject
            spyOn(remotePlugin.device, 'rejectTransfer');

            // Content expected to be reported by one test isn't by another
            localPlugin._pendingEchoes = [];
            remotePlugin._pendingEchoes = [];
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

    it('only advertises sharing images and files when enabled', function () {
        const service = new Core.ChannelService({id: 'test', name: 'test'});
        const settings = localPlugin._serviceSettings;
        const capability = 'kdeconnect.clipboard.file';

        settings.set_boolean('clipboard-files', false);
        service.buildIdentity();
        expect(service.identity.body.incomingCapabilities).not.toContain(capability);
        expect(service.identity.body.outgoingCapabilities).not.toContain(capability);
        expect(service.identity.body.incomingCapabilities).toContain('kdeconnect.clipboard');

        settings.set_boolean('clipboard-files', true);
        service.buildIdentity();
        expect(service.identity.body.incomingCapabilities).toContain(capability);
        expect(service.identity.body.outgoingCapabilities).toContain(capability);

        settings.set_boolean('clipboard-files', false);
    });

    it('does not read images or files when sharing them is disabled', async function () {
        spyOn(localPlugin._clipboard, 'getImage').and.callThrough();
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        localPlugin._clipboard.setFile(Utils.getDataUri('vcard-valid.vcf'));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        expect(localPlugin._clipboard.getImage).not.toHaveBeenCalled();
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('rejects files when sharing them is disabled', async function () {
        spyOn(remotePlugin.device, 'createTransfer');

        await remotePlugin._handleFile(filePacket('album.png'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('pushes images as PNG files', async function () {
        // The setting is shared by both plugins
        shareFiles(true, localPlugin, remotePlugin);
        localPlugin._clipboard.text = 'reset';
        await remotePlugin.awaitPacket('kdeconnect.clipboard', {
            content: 'reset',
        });

        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file');
        const [packet] = remotePlugin.handlePacket.calls.mostRecent().args;

        expect(packet.body.filename).toMatch(/^[0-9]+\.png$/);
        expect(packet.payloadSize).toBeGreaterThan(0);

        // The device receives the same image
        const {checksum} = await localPlugin._clipboard.getImage();
        await Utils.waitFor(() => {
            return remotePlugin._clipboard._image?.checksum === checksum;
        });
    });

    it('does not push the same image twice', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));

        spyOn(localPlugin, 'clipboardPush').and.callThrough();
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        // The re-encoded image has the same pixels
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('pushes copied files', async function () {
        localPlugin._clipboard.setFile(Utils.getDataUri('vcard-valid.vcf'));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file', {
            filename: 'vcard-valid.vcf',
        });

        // The device receives the same file
        await Utils.waitFor(() => {
            const {type, uri} = remotePlugin._clipboard.content;

            return type === 'file' && uri.endsWith('/vcard-valid.vcf');
        });

        const received = Gio.File.new_for_uri(remotePlugin._clipboard.content.uri);
        const [, data] = received.load_contents(null);
        const [, expected] = Utils.getDataFile('vcard-valid.vcf')
            .load_contents(null);
        expect(data).toEqual(expected);
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
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        localPlugin._clipboard.setFile(
            Gio.File.new_for_path(Utils.getDataPath('album.png'))
                .get_parent().get_uri());

        // Wait for the asynchronous file query
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.clipboardPush).toHaveBeenCalled();
        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('does not push files larger than allowed', async function () {
        spyOn(localPlugin, 'clipboardPush').and.callThrough();
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        // A sparse file, one byte larger than allowed
        const file = tempFile('large.bin', path => {
            const stream = Gio.File.new_for_path(path).replace(null, false,
                Gio.FileCreateFlags.NONE, null);
            stream.seek(MAX_FILE_SIZE, GLib.SeekType.SET, null);
            stream.write_bytes(new GLib.Bytes([0]), null);
            stream.close(null);
        });

        try {
            localPlugin._clipboard.setFile(file.get_uri());

            // Wait for the asynchronous file query
            await localPlugin.clipboardPush.calls.mostRecent().returnValue;
            expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        } finally {
            file.delete(null);
        }
    });

    it('does not push files to devices without support', async function () {
        const settings = localPlugin.device.settings;
        const incoming = settings.get_strv('incoming-capabilities');
        settings.set_strv('incoming-capabilities',
            incoming.filter(type => type !== 'kdeconnect.clipboard.file'));
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();
        spyOn(localPlugin._clipboard, 'getImage').and.callThrough();
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        localPlugin._clipboard.setFile(Utils.getDataUri('album.png'));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        // Image data isn't even read
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        expect(localPlugin._clipboard.getImage).not.toHaveBeenCalled();
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
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            await remotePlugin._handleFile(filePacket('album.png'));
            await remotePlugin._applyImage.calls.mostRecent().returnValue;

            expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
            await remotePlugin._clipboard.setImage.calls.mostRecent().returnValue;
            expect(remotePlugin._clipboard.content.type).toBe('image');

            // The received image must not be sent back
            await expectNotSentBack(remotePlugin);
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('receives other files into the clipboard as files', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);

        try {
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
            await expectNotSentBack(remotePlugin);
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('cancels receiving a file superseded by text', async function () {
        const transfer = pendingTransfer();
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

    it('rejects a file superseded before it was received', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        const packet = filePacket('superseded.bin');

        const received = remotePlugin._handleFile(packet);
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'superseding'},
        }));
        await received;

        // The device may still be waiting to send it
        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalledWith(packet);
    });

    it('cancels receiving a file superseded by a local copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._clipboard.text = 'copied locally';
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.text).toBe('copied locally');
    });

    it('keeps a file being received, once copied locally', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('copied.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // The partial file is copied, which supersedes receiving it
        const file = transfer.file;
        remotePlugin._clipboard._setContent({
            type: 'file',
            uri: file.get_uri(),
        });
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._currentDir.equal(file.get_parent())).toBeTrue();
        expect(file.query_exists(null)).toBeTrue();
    });

    it('keeps a received file copied locally as it is loaded', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));

        // The file is copied locally as it finishes loading
        spyOn(remotePlugin, '_loadFile').and.callFake(file => {
            remotePlugin._clipboard._setContent({
                type: 'file',
                uri: file.get_uri(),
            });

            return Promise.resolve({type: 'file', uri: file.get_uri()});
        });
        await remotePlugin._handleFile(filePacket('loaded.vcf'));
        const file = remotePlugin._loadFile.calls.mostRecent().args[0];

        expect(remotePlugin._currentDir.equal(file.get_parent())).toBeTrue();
        expect(file.query_exists(null)).toBeTrue();
    });

    it('removes a partially received file, even if destroyed', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        // The plugin isn't destroyed, since later tests use it, but its
        // operations are cancelled the same way
        const cancellable = new Gio.Cancellable();
        spyOnProperty(remotePlugin, 'cancellable').and.returnValue(cancellable);

        const received = remotePlugin._handleFile(filePacket('partial.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        const [path] = remotePlugin._receivingDirs;
        expect(transfer.file.query_exists(null)).toBeTrue();

        cancellable.cancel();
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(Gio.File.new_for_path(path).query_exists(null)).toBeFalse();
    });

    it('removes a partially received file when disconnected', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        remotePlugin.device.rejectTransfer.and.callThrough();

        const received = remotePlugin._handleFile(filePacket('partial.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        const [path] = remotePlugin._receivingDirs;

        // Like Device.setChannel(), the channel is gone before the plugins
        // are told, which cancels the transfer
        const channel = remotePlugin.device._channel;
        remotePlugin.device._channel = null;
        remotePlugin.device._connected = false;

        try {
            remotePlugin.disconnected();
            await received;
        } finally {
            remotePlugin.device._channel = channel;
            remotePlugin.device._connected = true;
            remotePlugin.connected();
        }

        expect(transfer.cancel).toHaveBeenCalled();
        expect(Gio.File.new_for_path(path).query_exists(null)).toBeFalse();
    });

    it('cancels sending content superseded by the device', function () {
        const transfer = {cancel: jasmine.createSpy('cancel')};
        localPlugin._outgoingTransfer = transfer;

        localPlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'from the device'},
        }));

        expect(transfer.cancel).toHaveBeenCalled();
        expect(localPlugin._outgoingTransfer).toBeNull();
    });

    it('does not forward files received from a device', async function () {
        const dir = localPlugin._getReceiveDirectory().get_child('forward');
        dir.make_directory(null);
        const file = dir.get_child('received.vcf');
        Utils.getDataFile('vcard-valid.vcf').copy(file,
            Gio.FileCopyFlags.NONE, null, null);
        spyOn(localPlugin.device, 'createTransfer');

        await localPlugin._sendFile({type: 'file', uri: file.get_uri()},
            localPlugin._localSerial, localPlugin._remoteSerial);

        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        await localPlugin._removeDirectory(dir);
    });

    it('keeps only current files when clearing the cache', async function () {
        const receiveDir = remotePlugin._getReceiveDirectory();
        const previous = remotePlugin._currentDir;

        for (const name of ['current', 'receiving', 'stale']) {
            const dir = receiveDir.get_child(name);
            dir.make_directory(null);
            dir.get_child('file').create(Gio.FileCreateFlags.NONE, null)
                .close(null);
        }

        remotePlugin._currentDir = receiveDir.get_child('current');
        remotePlugin._receivingDirs.add(
            receiveDir.get_child('receiving').get_path());

        await remotePlugin.clearCache();

        expect(listChildren(receiveDir).sort()).toEqual(['current', 'receiving']);

        remotePlugin._currentDir = previous;
        remotePlugin._receivingDirs.clear();
        await remotePlugin.clearCache();
    });

    it('checks the format of received images from their contents', async function () {
        // JPEG data named as PNG is converted, rather than offered as PNG
        const jpeg = tempFile('photo.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x336699ff);
            pixbuf.savev(path, 'jpeg', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(jpeg));
        spyOn(remotePlugin._clipboard, 'setImage').and.callThrough();
        spyOn(remotePlugin, '_applyImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('photo.png'));
        await remotePlugin._applyImage.calls.mostRecent().returnValue;

        const [bytes] = remotePlugin._clipboard.setImage.calls.mostRecent().args;
        const signature = bytes.toArray().slice(0, 4);
        expect(Array.from(signature)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('receives images in other formats as files', async function () {
        const svg = tempFile('drawing.svgz', path => {
            GLib.file_set_contents(path, '<svg xmlns="http://www.w3.org/2000/svg" ' +
                'width="16" height="16"><rect width="16" height="16"/></svg>');
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(svg));
        spyOn(remotePlugin._clipboard, 'setImage');
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin, '_loadImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('drawing.svgz'));

        // The data isn't even passed to an image loader
        expect(remotePlugin._loadImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('receives TIFF images as files', async function () {
        const tiff = tempFile('scan.tiff', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x996633ff);
            pixbuf.savev(path, 'tiff', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(tiff));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin, '_loadImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('scan.tiff'));

        expect(remotePlugin._loadImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('stops loading an image superseded by the device', async function () {
        const image = tempFile('superseded.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 64, 64);
            pixbuf.fill(0x123456ff);
            pixbuf.savev(path, 'png', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(image));
        spyOn(remotePlugin._clipboard, 'setImage');

        const loadImage = remotePlugin._loadImage.bind(remotePlugin);
        let path, result;
        spyOn(remotePlugin, '_loadImage').and.callFake((...args) => {
            [path] = remotePlugin._receivingDirs;

            // Newer content arrives while the image is loading
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'during load'},
            }));

            const loading = loadImage(...args);
            result = loading.catch(e => e);
            return loading;
        });

        await remotePlugin._handleFile(filePacket('superseded.png'));
        const error = await result;

        expect(error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)).toBeTrue();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(Gio.File.new_for_path(path).query_exists(null)).toBeFalse();
    });

    it('shortens long names of received files', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        await remotePlugin._handleFile(filePacket(`${'é'.repeat(300)}.vcf`));

        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        const name = Gio.File.new_for_uri(uri).get_basename();
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
        expect(name).toMatch(/^é+\.vcf$/);
    });

    it('rejects a file that can\'t be received', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.throwError('Failed');

        await remotePlugin._handleFile(filePacket('failed.bin'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
    });

    it('rejects a file without a name', async function () {
        spyOn(remotePlugin.device, 'createTransfer');

        await remotePlugin._handleFile(filePacket(null));

        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
    });

    it('cancels receiving a file when the same text is copied again', async function () {
        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'copied twice'},
        }));
        expect(remotePlugin._clipboard.text).toBe('copied twice');

        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._clipboard._setContent({type: 'text', text: 'copied twice'});
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('does not apply an image superseded by the device', async function () {
        const content = {
            type: 'image',
            checksum: 'superseded',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage');

        // A newer file starts being received while the image is read
        const applied = remotePlugin._applyImage(content);
        remotePlugin._remoteSerial++;
        await applied;

        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
    });

    it('keeps a received file reported again by the clipboard', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('reported.vcf'));
        const dir = remotePlugin._currentDir;
        const content = remotePlugin._clipboard.content;

        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            // A clipboard manager takes over the clipboard with the same
            // content
            remotePlugin._clipboard._setContent({...content});
            await remotePlugin.clearCache();

            expect(remotePlugin._currentDir).toBe(dir);
            expect(dir.query_exists(null)).toBeTrue();
            await expectNotSentBack(remotePlugin);
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('keeps a received file reported again after reconnecting', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('reconnected.vcf'));
        const dir = remotePlugin._currentDir;
        const content = remotePlugin._clipboard.content;

        // What was applied is forgotten on reconnecting, so the file is
        // reported again as a local change
        remotePlugin.connected();
        remotePlugin._clipboard._setContent({...content});
        await remotePlugin.clearCache();

        expect(remotePlugin._currentDir.equal(dir)).toBeTrue();
        expect(dir.query_exists(null)).toBeTrue();
    });

    it('does not keep a local file as a received one', function () {
        spyOn(remotePlugin, '_getReceiveDirectory').and.callThrough();

        // A file of another device is not this device's to keep
        const otherDevice = Gio.File.new_for_path(GLib.build_filenamev([
            Config.CACHEDIR, 'other-device', 'clipboard', 'dir', 'file',
        ]));

        for (const uri of [
            Utils.getDataUri('vcard-valid.vcf'),
            otherDevice.get_uri(),
            'file:///at-the-root',
        ]) {
            remotePlugin._clipboard._setContent({type: 'file', uri});
            expect(remotePlugin._currentDir).toBeNull();
        }

        // Nor is a directory created for it
        expect(remotePlugin._getReceiveDirectory).not.toHaveBeenCalled();
    });

    it('applies text another device sent before the clipboard reads back', function () {
        // The plugins share a clipboard in the service, if not in tests
        remotePlugin._clipboard.text = 'held before';
        const before = remotePlugin._clipboard.content;
        spyOn(remotePlugin, '_expectEcho').and.callThrough();

        try {
            // The other device's text is applied, but not yet read back
            localPlugin._expectEcho({type: 'text', text: 'other device'});

            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'held before'},
            }));

            // The text is set again, rather than taken for already there
            expect(remotePlugin._expectEcho).toHaveBeenCalled();
            expect(remotePlugin._clipboard.content).not.toBe(before);
        } finally {
            localPlugin._pendingEchoes = [];
        }
    });

    it('ignores content another device applied before this one sent', async function () {
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            // The other device's text is applied, then this device sends
            // text, before the first is read back
            localPlugin._expectEcho({type: 'text', text: 'other device'});
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'this device'},
            }));
            remotePlugin.device.sendPacket.calls.reset();
            const serial = remotePlugin._remoteSerial;

            // The other device's text is read back late, and recognized by
            // its plugin first
            const report = {type: 'text', text: 'other device'};
            expect(localPlugin._getAppliedContent(report)).not.toBeNull();
            remotePlugin._clipboard._setContent(report);

            expect(remotePlugin._remoteSerial).toBe(serial);
            await expectNotSentBack(remotePlugin);
        } finally {
            localPlugin._pendingEchoes = [];
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('ignores content another device applied, still expected by it', function () {
        spyOn(remotePlugin, 'clipboardPush');
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            localPlugin._expectEcho({type: 'text', text: 'other device'});
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'this device'},
            }));

            remotePlugin._clipboard._setContent({
                type: 'text',
                text: 'other device',
            });

            expect(remotePlugin.clipboardPush).not.toHaveBeenCalled();
        } finally {
            localPlugin._pendingEchoes = [];
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('sends content another device applied after this one sent', function () {
        spyOn(remotePlugin, 'clipboardPush');
        remotePlugin.settings.set_boolean('send-content', true);

        // Each is applied at a later time
        let now = GLib.get_monotonic_time();
        spyOn(GLib, 'get_monotonic_time').and.callFake(() => ++now);

        try {
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'this device'},
            }));
            localPlugin._expectEcho({type: 'text', text: 'other device'});

            remotePlugin._clipboard._setContent({
                type: 'text',
                text: 'other device',
            });

            expect(remotePlugin.clipboardPush).toHaveBeenCalled();
        } finally {
            localPlugin._pendingEchoes = [];
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('sends an image another device may have applied', function () {
        spyOn(remotePlugin, 'clipboardPush');
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            // Only that device's plugin can tell if it's the image applied
            localPlugin._expectEcho({type: 'image', checksum: 'other device'});
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'this device'},
            }));

            remotePlugin._clipboard._setContent({type: 'image'},
                {checksum: 'copied locally'});

            expect(remotePlugin.clipboardPush).toHaveBeenCalled();
        } finally {
            localPlugin._pendingEchoes = [];
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('only supersedes other devices with content it applies', async function () {
        const time = remotePlugin._remoteTime;

        // Rejected
        await remotePlugin._handleFile(filePacket('large.bin',
            MAX_FILE_SIZE + 1));
        expect(remotePlugin._remoteTime).toBe(time);

        // Not received
        remotePlugin.settings.set_boolean('receive-content', false);

        try {
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'not received'},
            }));
            expect(remotePlugin._remoteTime).toBe(time);
        } finally {
            remotePlugin.settings.set_boolean('receive-content', true);
        }

        // Superseded while received, after superseding another
        const createTransfer = spyOn(remotePlugin.device, 'createTransfer')
            .and.returnValues(pendingTransfer(), pendingTransfer());
        const received = [
            remotePlugin._handleFile(filePacket('superseded.bin')),
            remotePlugin._handleFile(filePacket('superseding.bin')),
        ];
        expect(remotePlugin._remoteTime).toBeGreaterThan(time);

        await Promise.idle(GLib.PRIORITY_DEFAULT);
        remotePlugin._clipboard.text = 'copied while received';
        await Promise.all(received);
        expect(remotePlugin._remoteTime).toBe(time);

        // Received, but no longer applied once loaded
        createTransfer.and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin, '_loadFile').and.callFake(file => {
            remotePlugin.settings.set_boolean('receive-content', false);
            return Promise.resolve({type: 'file', uri: file.get_uri()});
        });

        try {
            await remotePlugin._handleFile(filePacket('not applied.vcf'));
            expect(remotePlugin._loadFile).toHaveBeenCalled();
            expect(remotePlugin._remoteTime).toBe(time);
        } finally {
            remotePlugin.settings.set_boolean('receive-content', true);
        }
    });

    it('applies an image pulled again while it is applied', async function () {
        const image = tempFile('twice.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x13579bff);
            pixbuf.savev(path, 'png', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(image));
        spyOn(remotePlugin, '_applyImage').and.callThrough();
        await remotePlugin._handleFile(filePacket('twice.png'));
        await remotePlugin._applyImage.calls.mostRecent().returnValue;
        const checksum = remotePlugin._remoteContent.checksum;

        remotePlugin._clipboard.text = 'copied since';

        // Pulled again as soon as it's expected, before it is applied
        const expectEcho = remotePlugin._expectEcho;
        spyOn(remotePlugin, '_expectEcho').and.callFake(content => {
            expectEcho.call(remotePlugin, content);

            if (remotePlugin._expectEcho.calls.count() === 1)
                remotePlugin.clipboardPull();
        });
        remotePlugin.clipboardPull();
        await Promise.all(remotePlugin._applyImage.calls.all()
            .map(call => call.returnValue));

        const applied = await remotePlugin._clipboard.getImage();
        expect(applied?.checksum).toBe(checksum);
    });

    it('applies text sent again before the clipboard reads back', async function () {
        remotePlugin._clipboard.text = 'held before';
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);
        remotePlugin._clipboard.async = true;

        try {
            // The device sends other text, then what the clipboard held,
            // before the first is read back
            for (const text of ['sent between', 'held before']) {
                remotePlugin.handlePacket(new Core.Packet({
                    type: 'kdeconnect.clipboard',
                    body: {content: text},
                }));
            }

            await expectNotSentBack(remotePlugin);
            expect(remotePlugin._clipboard.content.text).toBe('held before');
        } finally {
            remotePlugin._clipboard.async = false;
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('compares an image with content applied but not yet read back', async function () {
        remotePlugin._clipboard._setContent({type: 'image'},
            {checksum: 'held before'});
        const image = {type: 'image', checksum: 'held before'};

        expect(await remotePlugin._isLocalImage(image)).toBeTrue();

        remotePlugin._expectEcho({type: 'text', text: 'applied since'});
        expect(await remotePlugin._isLocalImage(image)).toBeFalse();

        remotePlugin._expectEcho({type: 'image', checksum: 'held before'});
        expect(await remotePlugin._isLocalImage(image)).toBeTrue();
    });

    it('recognizes contents applied in quick succession', async function () {
        const image = tempFile('quick.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x654321ff);
            pixbuf.savev(path, 'png', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(image));
        spyOn(remotePlugin, '_applyImage').and.callThrough();
        remotePlugin._clipboard.async = true;

        try {
            await remotePlugin._handleFile(filePacket('quick.png'));
            await remotePlugin._applyImage.calls.mostRecent().returnValue;

            // Text arrives before the image is reported
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'right after the image'},
            }));
            const serial = remotePlugin._remoteSerial;
            expect(remotePlugin._pendingEchoes.length).toBe(2);

            // Neither is mistaken for a local copy
            await Utils.waitFor(() => remotePlugin._pendingEchoes.length === 0);
            expect(remotePlugin._remoteSerial).toBe(serial);
        } finally {
            remotePlugin._clipboard.async = false;
        }
    });

    it('recognizes many texts applied in quick succession', async function () {
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);
        remotePlugin._clipboard.async = true;

        try {
            // All are applied before the first is reported, which reports
            // the last, and some are applied more than once
            for (let i = 0; i < 8; i++) {
                remotePlugin.handlePacket(new Core.Packet({
                    type: 'kdeconnect.clipboard',
                    body: {content: `burst ${i % 3}`},
                }));
            }

            // None is sent back, although the device sent newer ones
            await Utils.waitFor(() => remotePlugin._pendingEchoes.length === 0);
            await Promise.idle(GLib.PRIORITY_DEFAULT);
            expect(remotePlugin._clipboard.text).toBe('burst 1');
            expect(remotePlugin.clipboardPush).not.toHaveBeenCalled();
            expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
        } finally {
            remotePlugin._clipboard.async = false;
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('stops expecting content that was never reported', function () {
        const now = GLib.get_monotonic_time();
        const spy = spyOn(GLib, 'get_monotonic_time').and.returnValue(now);
        const unreported = {type: 'text', text: 'unreported'};
        const later = {type: 'text', text: 'later'};

        try {
            remotePlugin._pendingEchoes = [];
            remotePlugin._expectEcho(unreported);

            // Content is applied again much later
            spy.and.returnValue(now + 60 * 1000 * 1000);
            remotePlugin._expectEcho(later);

            expect(remotePlugin._pendingEchoes).toEqual([later]);
        } finally {
            remotePlugin._pendingEchoes = [];
        }
    });

    it('recognizes texts reported once for several applied', async function () {
        watchPushes(remotePlugin);
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            for (const text of ['merged A', 'merged B', 'merged A']) {
                remotePlugin._expectEcho({type: 'text', text});
                remotePlugin._remoteContent = {type: 'text', text};
                remotePlugin._pulledContent = remotePlugin._remoteContent;
            }

            // The clipboard reports what it holds now
            remotePlugin._clipboard._setContent({type: 'text', text: 'merged A'});
            expect(remotePlugin._pendingEchoes).toEqual([]);

            // Copying an earlier one again is sent
            remotePlugin._clipboard._setContent({type: 'text', text: 'merged B'});
            await remotePlugin.clipboardPush.calls.mostRecent().returnValue;
            expect(remotePlugin.device.sendPacket).toHaveBeenCalledWith(
                jasmine.objectContaining({body: {content: 'merged B'}}));
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('does not recognize content expected for too long', function () {
        const now = GLib.get_monotonic_time();
        const spy = spyOn(GLib, 'get_monotonic_time').and.returnValue(now);
        const content = {type: 'text', text: 'never reported'};

        remotePlugin._expectEcho(content);
        spy.and.returnValue(now + 60 * 1000 * 1000);

        expect(remotePlugin._getAppliedContent({...content})).toBeNull();
    });

    it('forgets content expected before reconnecting', function () {
        remotePlugin._expectEcho({type: 'text', text: 'before reconnecting'});
        remotePlugin.connected();

        expect(remotePlugin._pendingEchoes).toEqual([]);
    });

    it('only pulls images and files while they are shared', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('unshared.vcf'));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        const settings = remotePlugin._serviceSettings;

        try {
            settings.set_boolean('clipboard-files', false);
            remotePlugin.clipboardPull();
            expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        } finally {
            settings.set_boolean('clipboard-files', true);
        }

        remotePlugin.clipboardPull();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('stops expecting an image that could not be applied', async function () {
        const content = {
            type: 'image',
            checksum: 'not applied',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage').and.resolveTo(false);

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
        expect(remotePlugin._pendingEchoes).not.toContain(content);
    });

    it('does not replace a local image with the same image', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        const local = await remotePlugin._clipboard.getImage();

        const content = {
            type: 'image',
            checksum: local.checksum,
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage');

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
    });

    it('hashes large images in chunks', async function () {
        const data = noise(1200 * 1000 * 4);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data),
            GdkPixbuf.Colorspace.RGB, true, 8, 1200, 1000, 1200 * 4);

        expect(await getImageChecksum(pixbuf)).toBe(
            referenceChecksum('1200x1000x4', data));
    });

    it('hashes images without the padding between rows', async function () {
        const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90, 11, 12, 13, 14, 15,
            16, 17, 18, 19];
        const expected = referenceChecksum('3x2x3', new Uint8Array(pixels));

        // The same pixels, with and without padding
        const padded = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes([
            ...pixels.slice(0, 9), 0, 0, 0, ...pixels.slice(9),
        ]), GdkPixbuf.Colorspace.RGB, false, 8, 3, 2, 12);
        const unpadded = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels),
            GdkPixbuf.Colorspace.RGB, false, 8, 3, 2, 9);

        expect(await getImageChecksum(padded)).toBe(expected);
        expect(await getImageChecksum(unpadded)).toBe(expected);
    });

    it('hashes large images with padding between rows', async function () {
        const [width, height, rowLength, rowstride] = [1001, 2000, 3003, 3004];
        const data = noise(rowLength * height);
        const padded = new Uint8Array(rowstride * height);

        for (let y = 0; y < height; y++) {
            padded.set(data.subarray(y * rowLength, (y + 1) * rowLength),
                y * rowstride);
        }

        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(padded),
            GdkPixbuf.Colorspace.RGB, false, 8, width, height, rowstride);

        expect(await getImageChecksum(pixbuf)).toBe(
            referenceChecksum(`${width}x${height}x3`, data));
    });

    it('cancels receiving a file through its cancellable', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._incomingCancellable.cancel();
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('applies a received image if the local image can\'t be read', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));

        const content = {
            type: 'image',
            checksum: 'unreadable',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'getImage').and.rejectWith(
            new Error('Unreadable'));
        spyOn(remotePlugin._clipboard, 'setImage').and.resolveTo(true);

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
    });

    it('applies text again after the clipboard is cleared', function () {
        const packet = new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'before clearing'},
        });

        remotePlugin.handlePacket(packet);
        remotePlugin._clipboard._setContent({type: 'text', text: ''});
        remotePlugin.handlePacket(packet);

        expect(remotePlugin._clipboard.content).toEqual({
            type: 'text',
            text: 'before clearing',
        });
    });

    it('treats a copied image mistaken for an applied one as a copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // An applied image is expected, but a different image is copied
        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('pushes a copied image mistaken for an applied one', async function () {
        remotePlugin.settings.set_boolean('send-content', true);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        spyOn(remotePlugin, '_sendImage').and.resolveTo();

        try {
            // An applied image is expected, but a different image is copied
            remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
            const image = tempFile('copied.png', path => {
                const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                    false, 8, 8, 8);
                pixbuf.fill(0x0f0f0fff);
                pixbuf.savev(path, 'png', [], []);
            });
            const [, contents] = image.load_contents(null);
            await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
            await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(remotePlugin._sendImage).toHaveBeenCalledTimes(1);
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('lets newer content from the device win over checking an image', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        const getImage = remotePlugin._clipboard.getImage.bind(
            remotePlugin._clipboard);
        let received = null;

        // The device starts sending a file while the copied image is read
        spyOn(remotePlugin._clipboard, 'getImage').and.callFake(() => {
            received ??= remotePlugin._handleFile(filePacket('newer.bin'));
            return getImage();
        });
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(transfer.cancel).not.toHaveBeenCalled();

        remotePlugin._cancelIncomingTransfer();
        await received;
    });

    it('cancels applying an image superseded by the device', async function () {
        const content = {
            type: 'image',
            checksum: 'cancelled',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;

        let cancellable = null;
        spyOn(remotePlugin._clipboard, 'setImage').and.callFake((...args) => {
            cancellable = args[2];
            return new Promise(() => {});
        });

        remotePlugin._applyImage(content);
        await Utils.waitFor(() => cancellable !== null);

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'newer than the image'},
        }));

        expect(cancellable.is_cancelled()).toBeTrue();
    });

    it('hashes tall, narrow images in a few chunks', async function () {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8,
            1, 2000000);
        pixbuf.fill(0x445566ff);
        spyOn(GLib.Bytes, 'new_from_bytes').and.callThrough();
        spyOn(GLib, 'compute_checksum_for_data').and.callThrough();

        await getImageChecksum(pixbuf);

        // Hashing row by row took several seconds, with rows read and hashed
        // one at a time
        expect(GLib.Bytes.new_from_bytes.calls.count()).toBeLessThan(10);
        expect(GLib.compute_checksum_for_data.calls.count()).toBeLessThan(10);
    });

    it('rejects files that are too large', async function () {
        spyOn(remotePlugin.device, 'createTransfer');

        await remotePlugin._handleFile(filePacket('big.bin', 100 * 1024 * 1024));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('rejects files when not allowed to pull content', async function () {
        remotePlugin.settings.set_boolean('receive-content', false);
        spyOn(remotePlugin.device, 'createTransfer');

        await remotePlugin._handleFile(filePacket('album.png'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
        remotePlugin.settings.set_boolean('receive-content', true);
    });

    it('pushes text copied again after the device sent a file', async function () {
        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'copied again'},
        }));

        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin.device, 'sendPacket');
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            const received = remotePlugin._handleFile(filePacket('slow.bin'));
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            // The device has the file, so the text is a new change
            remotePlugin._clipboard._setContent({type: 'text', text: 'copied again'});
            await received;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(remotePlugin.device.sendPacket).toHaveBeenCalledWith(
                jasmine.objectContaining({
                    type: 'kdeconnect.clipboard',
                    body: {content: 'copied again'},
                }));
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('applies a file received in full, even if disconnected', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        // The connection is lost while the file is loaded
        const loadFile = remotePlugin._loadFile.bind(remotePlugin);
        spyOn(remotePlugin, '_loadFile').and.callFake((...args) => {
            remotePlugin.disconnected();
            return loadFile(...args);
        });

        try {
            await remotePlugin._handleFile(filePacket('complete.vcf'));
        } finally {
            remotePlugin.connected();
        }

        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('does not push the path of a received file as text', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        localPlugin.settings.set_boolean('send-content', true);
        remotePlugin._clipboard.filesAsText = true;

        try {
            // A clipboard that can't hold a file gets its path
            await remotePlugin._handleFile(filePacket('as-text.vcf'));
            const {text} = remotePlugin._clipboard.content;
            expect(text).toMatch(/as-text\.vcf$/);

            // The plugin of another device sees it in the same clipboard
            localPlugin._clipboard.text = text;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();

            // Nor when connecting
            localPlugin.connected();
            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
        } finally {
            remotePlugin._clipboard.filesAsText = false;
            localPlugin.settings.set_boolean('send-content', false);
        }
    });

    it('recognizes images applied in quick succession reported once', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        const pixbuf = await decodeImage(new GLib.Bytes(contents));
        const checksum = await getImageChecksum(pixbuf);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        const serial = remotePlugin._remoteSerial;

        // Only the last of two applied images is reported
        remotePlugin._expectEcho({type: 'image', checksum: 'first'});
        remotePlugin._expectEcho({type: 'image', checksum: checksum});
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes.length).toBe(1);

        // The last image may still be reported itself
        remotePlugin._clipboard.emit('content-changed');
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes).toEqual([]);
    });

    it('keeps a received file reported again while receiving another', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('kept.vcf'));
        const dir = remotePlugin._currentDir;
        const content = remotePlugin._clipboard.content;

        // The device starts sending another file
        const transfer = pendingTransfer();
        remotePlugin.device.createTransfer.and.returnValue(transfer);
        const received = remotePlugin._handleFile(filePacket('next.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // A clipboard manager takes over the clipboard with the same file
        remotePlugin._clipboard._setContent({...content});
        await received;
        await remotePlugin.clearCache();

        expect(remotePlugin._currentDir).toBe(dir);
        expect(dir.query_exists(null)).toBeTrue();
    });

    it('ignores an image read superseded by the next applied image', async function () {
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        const serial = remotePlugin._remoteSerial;

        // Two images are applied, and the first is reported, but the second
        // replaces it while it is read
        remotePlugin._expectEcho({type: 'image', checksum: 'first'});
        remotePlugin._expectEcho({type: 'image', checksum: 'second'});
        spyOn(remotePlugin._clipboard, 'getImage').and.resolveTo(null);
        remotePlugin._clipboard._setContent({type: 'image', mimetype: 'image/png'});
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes).toEqual([
            {type: 'image', checksum: 'second'},
        ]);
        remotePlugin._pendingEchoes = [];
    });

    it('does not read a copied image again after failing to', async function () {
        remotePlugin.settings.set_boolean('send-content', true);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        spyOn(remotePlugin, 'clipboardPush').and.callThrough();
        spyOn(remotePlugin._clipboard, 'getImage').and.rejectWith(
            new Error('Image is too large'));

        try {
            remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
            remotePlugin._clipboard._setContent({type: 'image', mimetype: 'image/png'});
            await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            // It couldn't be sent either
            expect(remotePlugin._clipboard.getImage).toHaveBeenCalledTimes(1);
            expect(remotePlugin.clipboardPush).not.toHaveBeenCalled();
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('keeps the name of a received file on one line', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        await remotePlugin._handleFile(filePacket('two\nlines\r.vcf'));

        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        expect(Gio.File.new_for_uri(uri).get_basename()).toBe('two_lines_.vcf');
    });

    it('keeps the extension of a received file displayed', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        await remotePlugin._handleFile(filePacket('photo\u202egpj.vcf'));

        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        expect(Gio.File.new_for_uri(uri).get_basename()).toBe('photo_gpj.vcf');
    });

    it('stops receiving a file larger than allowed', async function () {
        const transfer = oversizedTransfer(true);
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');
        spyOn(remotePlugin._clipboard, 'setImage');
        const dir = remotePlugin._currentDir;

        const received = remotePlugin._handleFile(
            filePacket('declared-small.bin'));
        await Utils.waitFor(() => transfer.cancelled);
        await received;

        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(remotePlugin._currentDir).toBe(dir);
        expect(transfer.file.query_exists(null)).toBeFalse();
    });

    it('rejects a received file larger than allowed', async function () {
        const transfer = oversizedTransfer(false);
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');
        spyOn(remotePlugin._clipboard, 'setImage');
        const dir = remotePlugin._currentDir;

        await remotePlugin._handleFile(filePacket('declared-small.bin'));

        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(remotePlugin._currentDir).toBe(dir);
        expect(transfer.file.query_exists(null)).toBeFalse();

        // The file was received, so the transfer is over
        expect(remotePlugin.device.rejectTransfer).not.toHaveBeenCalled();
    });

    it('pushes a copied file again once it changed', async function () {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([Config.CONFIGDIR, 'changing.txt']));
        file.replace_contents('first', null, false,
            Gio.FileCreateFlags.NONE, null);

        spyOn(localPlugin, 'clipboardPush').and.callThrough();
        spyOn(localPlugin.device, 'createTransfer').and.callFake(() => ({
            addFile() {},
            start: () => Promise.resolve(),
        }));

        const copy = async () => {
            localPlugin._clipboard.setFile(file.get_uri());
            await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        };

        const setModified = modified => {
            file.set_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
                modified, Gio.FileQueryInfoFlags.NONE, null);
        };

        // Replaces the file with a new one
        const edit = (contents, modified) => {
            file.replace_contents(contents, null, false,
                Gio.FileCreateFlags.NONE, null);
            setModified(modified);
        };

        const getChanged = () => {
            const info = file.query_info('time::changed,time::changed-usec',
                Gio.FileQueryInfoFlags.NONE, null);

            return `${info.get_attribute_uint64('time::changed')}:` +
                `${info.get_attribute_uint32('time::changed-usec')}`;
        };

        // Overwrites the file in place, until its status change time differs
        // even where it is only updated every few milliseconds
        const overwrite = async (contents, modified) => {
            const changed = getChanged();
            const deadline = GLib.get_monotonic_time() + 2 * 1000 * 1000;

            do {
                if (GLib.get_monotonic_time() > deadline)
                    throw new Error('The status change time did not change');

                await new Promise(resolve => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                });

                const stream = file.open_readwrite(null);
                stream.output_stream.write_all(
                    new TextEncoder().encode(contents), null);
                stream.close(null);
                setModified(modified);
            } while (getChanged() === changed);
        };

        // Hides the status change time, as if it had not changed
        let hideChanged = false;
        const getUint64 = Gio.FileInfo.prototype.get_attribute_uint64;
        spyOn(Gio.FileInfo.prototype, 'get_attribute_uint64').and.callFake(
            function (name) {
                return hideChanged && name === Gio.FILE_ATTRIBUTE_TIME_CHANGED
                    ? 0 : getUint64.call(this, name);
            });
        const getUint32 = Gio.FileInfo.prototype.get_attribute_uint32;
        spyOn(Gio.FileInfo.prototype, 'get_attribute_uint32').and.callFake(
            function (name) {
                return hideChanged &&
                    name === Gio.FILE_ATTRIBUTE_TIME_CHANGED_USEC
                    ? 0 : getUint32.call(this, name);
            });

        localPlugin.settings.set_boolean('send-content', true);

        try {
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(1);

            // The same file is not sent again while unchanged
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(1);

            // An edit is noticed by the modification time, even if the size
            // is the same
            edit('third', 1000000000);
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(2);

            // Pulling the clipboard doesn't make it content from the device
            localPlugin.clipboardPull();
            hideChanged = true;
            edit('other', 1000000001);
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(3);

            // A replacement that keeps the modification time is noticed by
            // the new file
            edit('again', 1000000001);
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(4);

            // Once the status change time is shown again, the file is sent
            // again with it, to compare later edits with
            hideChanged = false;
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(5);

            // An edit in place that keeps the modification time is noticed by
            // the status change time
            await overwrite('final', 1000000001);
            await copy();
            expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(6);
        } finally {
            localPlugin.settings.set_boolean('send-content', false);
        }
    });

    it('pushes a copied file again without a modification time', async function () {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([Config.CONFIGDIR, 'untimed.txt']));
        file.replace_contents('first', null, false,
            Gio.FileCreateFlags.NONE, null);

        spyOn(localPlugin, 'clipboardPush').and.callThrough();
        spyOn(localPlugin.device, 'createTransfer').and.callFake(() => ({
            addFile() {},
            start: () => Promise.resolve(),
        }));
        const hasAttribute = Gio.FileInfo.prototype.has_attribute;
        spyOn(Gio.FileInfo.prototype, 'has_attribute').and.callFake(
            function (name) {
                return name !== Gio.FILE_ATTRIBUTE_TIME_MODIFIED &&
                    hasAttribute.call(this, name);
            });

        localPlugin.settings.set_boolean('send-content', true);

        try {
            for (let i = 1; i <= 2; i++) {
                localPlugin._clipboard.setFile(file.get_uri());
                await localPlugin.clipboardPush.calls.mostRecent().returnValue;
                expect(localPlugin.device.createTransfer).toHaveBeenCalledTimes(i);
            }
        } finally {
            localPlugin.settings.set_boolean('send-content', false);
        }
    });

    it('stops receiving a file when sharing files is disabled', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');
        const settings = remotePlugin._serviceSettings;
        settings.set_boolean('clipboard-files', true);

        const received = remotePlugin._handleFile(filePacket('disabled.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        try {
            settings.set_boolean('clipboard-files', false);
            await received;
        } finally {
            settings.set_boolean('clipboard-files', true);
        }

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
    });

    it('stops sending a file when sharing files is disabled', function () {
        const transfer = {cancel: jasmine.createSpy('cancel')};
        localPlugin._outgoingTransfer = transfer;
        const settings = localPlugin._serviceSettings;

        try {
            settings.set_boolean('clipboard-files', false);
        } finally {
            settings.set_boolean('clipboard-files', true);
        }

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('only sends files once the device is told they are shared', function () {
        try {
            shareFiles(false, localPlugin);

            // The device wasn't told files are sent when it connected
            localPlugin._serviceSettings.set_boolean('clipboard-files', true);
            expect(localPlugin._canSendFiles()).toBeFalse();
        } finally {
            shareFiles(true, localPlugin);
        }

        expect(localPlugin._canSendFiles()).toBeTrue();
    });

    it('keeps the file the device holds after a local copy', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('held.vcf'));
        const {uri} = remotePlugin._clipboard.content;

        // A local copy, which isn't sent to the device
        remotePlugin._clipboard.text = 'copied locally';
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(remotePlugin._currentDir).toBeNull();

        await remotePlugin.clearCache();
        expect(Gio.File.new_for_uri(uri).query_exists(null)).toBeTrue();

        // The device's file can still be pulled
        remotePlugin.clipboardPull();
        expect(remotePlugin._clipboard.content.uri).toBe(uri);
    });

    it('keeps an existing directory it failed to create', async function () {
        const now = Date.now();
        spyOn(Date, 'now').and.returnValue(now);

        const existing = remotePlugin._getReceiveDirectory().get_child(
            `${now}-${remotePlugin._remoteSerial + 1}`);
        existing.make_directory(null);

        remotePlugin._serviceSettings.set_boolean('clipboard-files', true);
        remotePlugin.settings.set_boolean('receive-content', true);
        await remotePlugin._handleFile(filePacket('existing.vcf'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin._receivingDirs.size).toBe(0);
        expect(remotePlugin._currentDir?.get_path()).not.toBe(existing.get_path());
        expect(existing.query_exists(null)).toBeTrue();
        Utils.removeDirectory(existing);
    });

    it('checks the format of a received image before decoding it', async function () {
        const cancellable = new Gio.Cancellable();
        spyOn(GdkPixbuf.Pixbuf, 'new_from_stream_async').and.callThrough();

        await expectAsync(remotePlugin._loadImage(
            Utils.getDataFile('album.png'), 'jpeg', cancellable))
            .toBeRejectedWithError(/Unexpected image format/);
        expect(GdkPixbuf.Pixbuf.new_from_stream_async).not.toHaveBeenCalled();
    });

    it('treats a copied image that can\'t be read as a copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // An applied image is still expected, but the copied image is too
        // large to be read
        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        spyOn(remotePlugin._clipboard, 'getImage').and.rejectWith(
            new Error('Image is too large'));
        remotePlugin._clipboard._setContent({type: 'image', mimetype: 'image/png'});
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('removes image data once decoded', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await decodeImage(new GLib.Bytes(contents));

        // The data is removed in the background
        const runtimeDir = Gio.File.new_for_path(Config.RUNTIMEDIR);
        await Utils.waitFor(() => !listChildren(runtimeDir)
            .some(name => name.startsWith('clipboard-image-')));
    });

    it('does not decode images with too many pixels', async function () {
        const bytes = new GLib.Bytes(Utils.createHugePng(20000, 20000));

        await expectAsync(decodeImage(bytes)).toBeRejectedWithError(
            /too large/);
    });

    it('disables its GActions when disconnected', function () {
        const incoming = {cancel: jasmine.createSpy('cancel')};
        const outgoing = {cancel: jasmine.createSpy('cancel')};
        localPlugin._incomingTransfer = incoming;
        localPlugin._outgoingTransfer = outgoing;

        testRig.setConnected(false);

        // Pending transfers are cancelled
        expect(incoming.cancel).toHaveBeenCalled();
        expect(outgoing.cancel).toHaveBeenCalled();

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeFalse();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeFalse();
    });
});

