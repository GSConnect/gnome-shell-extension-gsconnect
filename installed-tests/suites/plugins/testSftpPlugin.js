'use strict';

const Utils = imports.fixtures.utils;
const {Plugin} = imports.service.plugin;


const Packets = {
    response: {
        type: 'kdeconnect.sftp',
        body: {
            ip: '127.0.0.1',
            port: 2039,
            user: 'kdeconnect',
            password: 'remote-password',
            path: '/',
            multiPaths: [
                '/remote-directory',
            ],
            pathNames: [
                'Remote',
            ],
        },
    },
    error: {
        type: 'kdeconnect.sftp',
        body: {
            errorMessage: 'Error Message',
        },
    },
};


function handlePacket(packet) {
    switch (packet.type) {
        case 'kdeconnect.sftp.request':
            this.sendPacket(Packets.response);
            break;
    }
}


describe('The sftp plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: ['kdeconnect.sftp.request'],
                outgoingCapabilities: ['kdeconnect.sftp'],
            },
            remoteDevice: {
                incomingCapabilities: ['kdeconnect.sftp'],
                outgoingCapabilities: ['kdeconnect.sftp'],
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
        remoteDevice.handlePacket = handlePacket.bind(remoteDevice);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin, '_handleMount');
            spyOn(localPlugin.device, 'showNotification');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('sftp');

        expect(localPlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        // NOTE: chaining-up to avoid the guard against Core.Channel type
        Plugin.prototype.connected.call(localPlugin);

        expect(localPlugin.device.get_action_enabled('mount')).toBeTrue();
        expect(localPlugin.device.get_action_enabled('unmount')).toBeTrue();
    });

    it('can request a mount', async function () {
        localPlugin.mount();

        await localPlugin.awaitPacket('kdeconnect.sftp', Packets.response.body);

        expect(localPlugin._handleMount).toHaveBeenCalled();
    });

    it('can handle error messages', async function () {
        remoteDevice.sendPacket(Packets.error);

        await localPlugin.awaitPacket('kdeconnect.sftp', Packets.error.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('mount')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('unmount')).toBeFalse();
    });
});

