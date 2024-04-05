// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


describe('The runcommand plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('runcommand');
        remotePlugin = testRig.remoteDevice._plugins.get('runcommand');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('executeCommand')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('executeCommand')).toBeTrue();
    });

    it('sends and request the list of commands when connected', async function () {
        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.runcommand.request', {
            requestCommandList: true,
        });

        await remotePlugin.awaitPacket('kdeconnect.runcommand', {
            commandList: {},
        });
    });

    it('sends the command list when it changes', async function () {
        const commandList = new GLib.Variant('a{sv}', {
            'command-uuid': new GLib.Variant('a{ss}', {
                name: 'Test Command',
                command: 'ls',
            }),
        });

        localPlugin.settings.set_value('command-list', commandList);

        await remotePlugin.awaitPacket('kdeconnect.runcommand', {
            commandList: '{"command-uuid":{"name":"Test Command","command":"ls"}}',
        });

        expect(remotePlugin.remote_commands['command-uuid']).toBeDefined();
    });

    it('can activate a remote command', async function () {
        spyOn(localPlugin.device, 'launchProcess');
        remotePlugin.executeCommand('command-uuid');

        await localPlugin.awaitPacket('kdeconnect.runcommand.request', {
            key: 'command-uuid',
        });

        expect(localPlugin.device.launchProcess).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('executeCommand')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('executeCommand')).toBeFalse();
    });
});

