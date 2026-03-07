// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';


describe('The share plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.share.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.share.request',
                ],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (remotePlugin)
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('share');
        remotePlugin = testRig.remoteDevice._plugins.get('share');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeTrue();

        for (const action in remotePlugin._meta.actions)
            expect(remotePlugin.device.get_action_enabled(action)).toBeTrue();
    });

    it('can send and receive files', async function () {
        spyOn(remotePlugin, '_handleFile');

        localPlugin.shareFile(Utils.getDataPath('album.png'));

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            filename: 'album.png',
        });

        expect(remotePlugin._handleFile).toHaveBeenCalled();
    });

    it('can send and receive text', async function () {
        spyOn(remotePlugin, '_handleText');

        localPlugin.shareText('shared text');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            text: 'shared text',
        });

        expect(remotePlugin._handleText).toHaveBeenCalled();
    });

    it('treats URIs as text by default', async function () {
        spyOn(remotePlugin, '_handleText');

        localPlugin.shareUri('https://www.gnome.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            url: 'https://www.gnome.org/',
        });

        expect(remotePlugin._handleText).toHaveBeenCalled();
    });

    it('launches URIs directly when configured to do so', async function () {
        remotePlugin.settings.set_boolean('launch-urls', true);
        spyOn(remotePlugin, '_handleUri');

        localPlugin.shareUri('https://www.gnome.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            url: 'https://www.gnome.org/',
        });

        expect(remotePlugin._handleUri).toHaveBeenCalled();
        remotePlugin.settings.set_boolean('launch-urls', false);
    });

    it('also detects and launches URIs in text shares', async function () {
        remotePlugin.settings.set_boolean('launch-urls', true);
        spyOn(remotePlugin, '_handleUri');

        localPlugin.shareText('GTK Documentation https://docs.gtk.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            text: 'GTK Documentation https://docs.gtk.org/',
        });

        expect(remotePlugin._handleUri).toHaveBeenCalled();
        remotePlugin.settings.set_boolean('launch-urls', false);
    });

    xit('interprets file URIs as file shares', async function () {
        spyOn(remotePlugin, '_handleFile');

        localPlugin.shareUri('file:///home/user/file.ext');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            filename: 'file.ext',
        });

        expect(remotePlugin._handleFile).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeFalse();

        for (const action in remotePlugin._meta.actions)
            expect(remotePlugin.device.get_action_enabled(action)).toBeFalse();
    });
});
