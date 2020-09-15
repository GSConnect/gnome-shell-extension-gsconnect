'use strict';

const Utils = imports.fixtures.utils;


describe('The clipboard plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.clipboard',
                    'kdeconnect.clipboard.connect',
                ],
                outgoingCapabilities: [
                    'kdeconnect.clipboard',
                    'kdeconnect.clipboard.connect',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.clipboard',
                    'kdeconnect.clipboard.connect',
                ],
                outgoingCapabilities: [
                    'kdeconnect.clipboard',
                    'kdeconnect.clipboard.connect',
                ],
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
        expect(remotePlugin._remoteBuffer).toBe('initial');

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
        expect(remotePlugin._remoteBuffer).toBe('bar');
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

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeFalse();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeFalse();
    });
});

