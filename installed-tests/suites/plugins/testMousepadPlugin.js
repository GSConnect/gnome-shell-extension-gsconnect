'use strict';

const Utils = imports.fixtures.utils;

const {Gdk} = imports.gi;


describe('The mousepad plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.mousepad.echo',
                    'kdeconnect.mousepad.keyboardstate',
                    'kdeconnect.mousepad.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.mousepad.echo',
                    'kdeconnect.mousepad.keyboardstate',
                    'kdeconnect.mousepad.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.mousepad.echo',
                    'kdeconnect.mousepad.keyboardstate',
                    'kdeconnect.mousepad.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.mousepad.echo',
                    'kdeconnect.mousepad.keyboardstate',
                    'kdeconnect.mousepad.request',
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
            spyOn(localPlugin, '_handleEcho').and.callThrough();

            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, '_sendEcho').and.callThrough();

            spyOn(remotePlugin._input, 'clickPointer');
            spyOn(remotePlugin._input, 'doubleclickPointer');
            spyOn(remotePlugin._input, 'pressPointer');
            spyOn(remotePlugin._input, 'releasePointer');
            spyOn(remotePlugin._input, 'movePointer');
            spyOn(remotePlugin._input, 'scrollPointer');
            spyOn(remotePlugin._input, 'pressKey');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('mousepad');
        remotePlugin = testRig.remoteDevice._plugins.get('mousepad');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('keyboard')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('keyboard')).toBeTrue();
    });

    it('sends its keyboard state when connected', async function () {
        const localState = localPlugin.settings.get_boolean('share-control');
        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.mousepad.keyboardstate');
        expect(remotePlugin.state).toBe(localState);
    });

    it('sends its keyboard state when changed', async function () {
        const previousState = localPlugin.settings.get_boolean('share-control');
        localPlugin.settings.set_boolean('share-control', !previousState);

        await remotePlugin.awaitPacket('kdeconnect.mousepad.keyboardstate');
        expect(remotePlugin.state).toBe(!previousState);
    });

    describe('handles keypresses', function () {
        const keyModifiers = Gdk.ModifierType.MOD1_MASK |
            Gdk.ModifierType.SHIFT_MASK;
        const specialModifiers = Gdk.ModifierType.CONTROL_MASK |
            Gdk.ModifierType.SUPER_MASK;

        it('without modifiers', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {key: 'a'},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.pressKey).toHaveBeenCalledWith('a', 0);
        });

        it('with modifiers', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    key: 'b',
                    alt: true,
                    ctrl: false,
                    shift: true,
                    super: false,
                },
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.pressKey).toHaveBeenCalledWith('b',
                keyModifiers);
        });

        it('for special keys without modifiers', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {specialKey: 1},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.pressKey).toHaveBeenCalledWith(
                Gdk.KEY_BackSpace, 0);
        });

        it('for special keys with modifiers', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    specialKey: 2,
                    alt: false,
                    ctrl: true,
                    shift: false,
                    super: true,
                },
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.pressKey).toHaveBeenCalledWith(
                Gdk.KEY_Tab, specialModifiers);
        });

        it('and sends an acknowledging packet', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    key: 'c',
                    sendAck: true,
                },
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._sendEcho).toHaveBeenCalled();

            await localPlugin.awaitPacket('kdeconnect.mousepad.echo');
            expect(localPlugin._handleEcho).toHaveBeenCalledWith({
                key: 'c',
                isAck: true,
            });
        });
    });

    describe('handles pointer events', function () {
        it('for movement', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    dx: 1,
                    dy: -1,
                },
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.movePointer).toHaveBeenCalledWith(1, -1);
        });

        it('for scrolling', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {
                    dx: 0,
                    dy: 1,
                    scroll: true,
                },
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.scrollPointer).toHaveBeenCalledWith(0, 1);
        });

        it('for left clicks', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {singleclick: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.clickPointer).toHaveBeenCalledWith(
                Gdk.BUTTON_PRIMARY);
        });

        it('for middle clicks', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {middleclick: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.clickPointer).toHaveBeenCalledWith(
                Gdk.BUTTON_MIDDLE);
        });

        it('for right clicks', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {rightclick: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.clickPointer).toHaveBeenCalledWith(
                Gdk.BUTTON_SECONDARY);
        });

        it('for double clicks', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {doubleclick: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.doubleclickPointer).toHaveBeenCalledWith(
                Gdk.BUTTON_PRIMARY);
        });

        it('for button presses', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {singlehold: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.pressPointer).toHaveBeenCalledWith(
                Gdk.BUTTON_PRIMARY);
        });

        it('for button releases', async function () {
            localPlugin.device.sendPacket({
                type: 'kdeconnect.mousepad.request',
                body: {singlerelease: true},
            });

            await remotePlugin.awaitPacket('kdeconnect.mousepad.request');
            expect(remotePlugin._input.releasePointer).toHaveBeenCalledWith(
                Gdk.BUTTON_PRIMARY);
        });
    });

    // TODO
    it('ignores input events when not allowed', function () {
        expect(true).toBeTrue();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('keyboard')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('keyboard')).toBeFalse();
    });
});

