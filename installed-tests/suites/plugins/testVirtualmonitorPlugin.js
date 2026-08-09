// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';


const PACKET = 'kdeconnect.virtualmonitor';
const REQUEST_PACKET = 'kdeconnect.virtualmonitor.request';
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
GSConnect virtual monitor test certificate
-----END CERTIFICATE-----`;

const RUNTIME = {
    available: true,
    reason: '',
    executable: '/test/runtime/krdpserver',
    capabilities: {
        apiVersion: 1,
        virtualMonitorRequestedSize: true,
        passwordFd: true,
        listenAddress: true,
        tls: true,
        sessionModes: ['monitor', 'virtualMonitor'],
    },
};

const MONITORS = [{
    index: 0,
    name: 'Test Display',
    width: 1920,
    height: 1080,
    scale: 1,
    primary: true,
}];


function packet(type, body) {
    return {type, body};
}


function request(sessionId) {
    return packet(REQUEST_PACKET, {
        action: 'request',
        protocolVersion: 2,
        sessionId,
        mode: 'virtualMonitor',
        width: 1920,
        height: 1080,
        scale: 1,
        quality: 80,
    });
}


function mockRuntime(plugin) {
    spyOn(plugin, '_runtimeCapabilities').and.returnValue(RUNTIME);
    spyOn(plugin, '_getMonitors').and.returnValue(MONITORS);
}


function markLan(plugin) {
    plugin.device.settings.set_string(
        'last-connection', 'lan://127.0.0.1:1716');
}


describe('The virtual monitor plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [PACKET, REQUEST_PACKET],
                outgoingCapabilities: [PACKET, REQUEST_PACKET],
            },
            remoteDevice: {
                incomingCapabilities: [PACKET, REQUEST_PACKET],
                outgoingCapabilities: [PACKET, REQUEST_PACKET],
            },
        });
        testRig.setPaired(true);

        testRig.localChannel.local_host = '127.0.0.1';
        testRig.remoteChannel.local_host = '127.0.0.1';
        testRig.localDevice.settings.set_string(
            'certificate-pem', TEST_CERTIFICATE);
        testRig.remoteDevice.settings.set_string(
            'certificate-pem', TEST_CERTIFICATE);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            localPlugin.device.settings.set_string(
                'certificate-pem', TEST_CERTIFICATE);
            localPlugin.settings.set_string(
                'remote-desktop-certificate', '');
        }
    });

    afterEach(function () {
        if (localPlugin)
            localPlugin._stopSession(false);
    });

    it('can be loaded with the bidirectional protocol-v2 packet types', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('virtualmonitor');
        remotePlugin = testRig.remoteDevice._plugins.get('virtualmonitor');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
        expect(localPlugin._meta.incomingCapabilities).toContain(PACKET);
        expect(localPlugin._meta.incomingCapabilities).toContain(REQUEST_PACKET);
        expect(localPlugin._meta.outgoingCapabilities).toContain(PACKET);
        expect(localPlugin._meta.outgoingCapabilities).toContain(REQUEST_PACKET);
    });

    it('enables its lifecycle GActions when connected', async function () {
        mockRuntime(localPlugin);
        mockRuntime(remotePlugin);
        await testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled(
            'acceptRemoteDesktop')).toBeTrue();
        expect(localPlugin.device.get_action_enabled(
            'rejectRemoteDesktop')).toBeTrue();
        expect(localPlugin.device.get_action_enabled(
            'stopRemoteDesktop')).toBeTrue();
    });

    it('advertises protocol-v2 capabilities when connected', function () {
        mockRuntime(localPlugin);
        spyOn(localPlugin.device, 'sendPacket');
        markLan(localPlugin);
        localPlugin.connected();

        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    action: 'capabilities',
                    protocolVersion: 2,
                    supports_remote_desktop: true,
                    sessionModes: ['monitor', 'virtualMonitor'],
                    monitors: MONITORS,
                    rdpFeatures: jasmine.any(Object),
                }),
            }));
    });

    it('answers an explicit capability refresh request', function () {
        mockRuntime(localPlugin);
        spyOn(localPlugin.device, 'sendPacket');
        markLan(localPlugin);

        localPlugin.handlePacket(packet(REQUEST_PACKET, {
            action: 'requestCapabilities',
            protocolVersion: 2,
        }));

        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    action: 'capabilities',
                    protocolVersion: 2,
                    supports_remote_desktop: true,
                }),
            }));
    });

    it('validates the machine-readable private runtime API', function () {
        const executable = GLib.build_filenamev([
            Config.RUNTIMEDIR,
            'test-krdpserver',
        ]);
        const oldRuntime = GLib.getenv('GSCONNECT_KRDP_SERVER');
        const oldSessionType = GLib.getenv('XDG_SESSION_TYPE');
        const script = `#!/bin/sh
printf '%s\\n' '{"apiVersion":1,"virtualMonitorRequestedSize":true,"passwordFd":true,"listenAddress":true,"tls":true,"sessionModes":["monitor","virtualMonitor"]}'
`;

        try {
            GLib.file_set_contents(executable, script);
            GLib.chmod(executable, 0o700);
            GLib.setenv('GSCONNECT_KRDP_SERVER', executable, true);
            GLib.setenv('XDG_SESSION_TYPE', 'wayland', true);
            localPlugin._runtimeExecutable = undefined;
            spyOn(localPlugin, '_getMonitors').and.returnValue(MONITORS);
            markLan(localPlugin);

            const runtime = localPlugin._runtimeCapabilities();

            expect(runtime.available).toBeTrue();
            expect(runtime.executable).toBe(executable);
            expect(runtime.capabilities.apiVersion).toBe(1);
        } finally {
            localPlugin._runtimeExecutable = undefined;
            Gio.File.new_for_path(executable).delete(null);

            if (oldRuntime === null)
                GLib.unsetenv('GSCONNECT_KRDP_SERVER');
            else
                GLib.setenv('GSCONNECT_KRDP_SERVER', oldRuntime, true);

            if (oldSessionType === null)
                GLib.unsetenv('XDG_SESSION_TYPE');
            else
                GLib.setenv('XDG_SESSION_TYPE', oldSessionType, true);
        }
    });

    it('rejects non-object runtime capability JSON without throwing', function () {
        const executable = GLib.build_filenamev([
            Config.RUNTIMEDIR,
            'test-krdpserver-malformed',
        ]);
        const oldRuntime = GLib.getenv('GSCONNECT_KRDP_SERVER');

        try {
            GLib.setenv('GSCONNECT_KRDP_SERVER', executable, true);

            for (const output of ['null', '[]', '42', '"text"']) {
                GLib.file_set_contents(executable, `#!/bin/sh
printf '%s\\n' '${output}'
`);
                GLib.chmod(executable, 0o700);
                localPlugin._runtimeExecutable = undefined;

                const runtime = localPlugin._runtimeCapabilities();

                expect(runtime.available).toBeFalse();
                expect(runtime.capabilities).toBeNull();
            }
        } finally {
            localPlugin._runtimeExecutable = undefined;

            try {
                Gio.File.new_for_path(executable).delete(null);
            } catch {
            }

            if (oldRuntime === null)
                GLib.unsetenv('GSCONNECT_KRDP_SERVER');
            else
                GLib.setenv('GSCONNECT_KRDP_SERVER', oldRuntime, true);
        }
    });

    it('retries runtime resolution after an executable appears', function () {
        const executable = GLib.build_filenamev([
            Config.RUNTIMEDIR,
            'test-krdpserver-late',
        ]);
        const file = Gio.File.new_for_path(executable);
        const oldRuntime = GLib.getenv('GSCONNECT_KRDP_SERVER');

        try {
            try {
                file.delete(null);
            } catch {
            }

            GLib.setenv('GSCONNECT_KRDP_SERVER', executable, true);
            localPlugin._runtimeExecutable = undefined;
            expect(localPlugin._resolveRuntimeExecutable()).toBeNull();

            GLib.file_set_contents(executable, '#!/bin/sh\nexit 0\n');
            GLib.chmod(executable, 0o700);

            expect(localPlugin._resolveRuntimeExecutable()).toBe(executable);
        } finally {
            localPlugin._runtimeExecutable = undefined;

            try {
                file.delete(null);
            } catch {
            }

            if (oldRuntime === null)
                GLib.unsetenv('GSCONNECT_KRDP_SERVER');
            else
                GLib.setenv('GSCONNECT_KRDP_SERVER', oldRuntime, true);
        }
    });

    it('creates one-time TLS credentials with a SHA-256 fingerprint', function () {
        const credentials = localPlugin._createTlsCredentials();

        try {
            expect(GLib.file_test(
                credentials.certificate,
                GLib.FileTest.IS_REGULAR
            )).toBeTrue();
            expect(GLib.file_test(
                credentials.key,
                GLib.FileTest.IS_REGULAR
            )).toBeTrue();
            expect(credentials.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        } finally {
            localPlugin._removeTlsDirectory(credentials.directory);
        }
    });

    it('rejects requests with an invalid protocol version', function () {
        spyOn(localPlugin.device, 'sendPacket');

        localPlugin.handlePacket(packet(REQUEST_PACKET, {
            action: 'request',
            protocolVersion: 1,
            sessionId: 'wrong-version',
            mode: 'virtualMonitor',
            width: 1920,
            height: 1080,
            scale: 1,
            quality: 80,
        }));

        expect(localPlugin.device.sendPacket).not.toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    sessionId: 'wrong-version',
                    status: 'starting',
                }),
            }));
    });

    it('rejects unsafe session identifiers without starting RDP', function () {
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'sendPacket');

        for (const sessionId of [
            '',
            'x'.repeat(129),
            'contains a space',
            'contains\nnewline',
            'contains\u0000nul',
            'contains\u001bescape',
            'nicht-ascii-ü',
        ]) {
            localPlugin.handlePacket(request(sessionId));
        }

        expect(localPlugin._startSession).not.toHaveBeenCalled();
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('rejects unsupported session modes without asking for consent', function () {
        mockRuntime(localPlugin);
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'showNotification');
        markLan(localPlugin);
        const invalidRequest = request('unsupported-session-mode');
        invalidRequest.body.mode = 'workspace';

        localPlugin.handlePacket(invalidRequest);

        expect(localPlugin._startSession).not.toHaveBeenCalled();
        expect(localPlugin.device.showNotification).not.toHaveBeenCalled();
    });

    it('requires local consent before starting a remote desktop session', function () {
        const sessionId = 'requires-local-consent';
        mockRuntime(localPlugin);
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'sendPacket');
        spyOn(localPlugin.device, 'showNotification');
        markLan(localPlugin);

        localPlugin.handlePacket(request(sessionId));

        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    action: 'status',
                    protocolVersion: 2,
                    sessionId,
                    status: 'awaitingPermission',
                }),
            }));
        expect(localPlugin.device.showNotification).toHaveBeenCalled();
        expect(localPlugin._startSession).not.toHaveBeenCalled();

        localPlugin.acceptRemoteDesktop(sessionId);

        expect(localPlugin._startSession).toHaveBeenCalledOnceWith(
            jasmine.objectContaining({
                sessionId,
                mode: 'virtualMonitor',
                width: 1920,
                height: 1080,
                scale: 1,
                quality: 80,
            }));
    });

    it('reuses consent only for the same paired certificate', function () {
        const sessionId = 'persisted-certificate-consent';
        const fingerprint = localPlugin._pairedCertificateFingerprint();
        mockRuntime(localPlugin);
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'showNotification');
        markLan(localPlugin);
        localPlugin.settings.set_string(
            'remote-desktop-certificate', fingerprint);

        localPlugin.handlePacket(request(sessionId));

        expect(localPlugin._startSession).toHaveBeenCalledOnceWith(
            jasmine.objectContaining({sessionId}));
        expect(localPlugin.device.showNotification).not.toHaveBeenCalled();
    });

    it('revokes persisted consent when the paired certificate changes', function () {
        const sessionId = 'certificate-changed';
        const fingerprint = localPlugin._pairedCertificateFingerprint();
        spyOn(localPlugin.device, 'sendPacket');
        localPlugin.settings.set_string(
            'remote-desktop-certificate', fingerprint);
        localPlugin._currentRequest = {sessionId};

        localPlugin.device.settings.set_string(
            'certificate-pem', `${TEST_CERTIFICATE}\nchanged`);

        expect(localPlugin.settings.get_string(
            'remote-desktop-certificate')).toBe('');
        expect(localPlugin._currentRequest).toBeNull();
        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    sessionId,
                    status: 'stopped',
                }),
            }));
    });

    it('tears down an active session when access is explicitly revoked', function () {
        const sessionId = 'explicit-access-revocation';
        const fingerprint = localPlugin._pairedCertificateFingerprint();
        spyOn(localPlugin.device, 'sendPacket');
        localPlugin.settings.set_string(
            'remote-desktop-certificate', fingerprint);
        localPlugin._currentRequest = {sessionId};

        localPlugin.revokeRemoteDesktop();

        expect(localPlugin.settings.get_string(
            'remote-desktop-certificate')).toBe('');
        expect(localPlugin._currentRequest).toBeNull();
        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    sessionId,
                    status: 'stopped',
                }),
            }));
    });

    it('fails a request when local consent is rejected', function () {
        const sessionId = 'rejected-by-local-user';
        mockRuntime(localPlugin);
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'sendPacket');
        markLan(localPlugin);

        localPlugin.handlePacket(request(sessionId));
        localPlugin.rejectRemoteDesktop(sessionId);

        expect(localPlugin._startSession).not.toHaveBeenCalled();
        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    action: 'status',
                    protocolVersion: 2,
                    sessionId,
                    status: 'failed',
                }),
            }));
    });

    it('does not ask for consent when the private runtime is unavailable', function () {
        const sessionId = 'runtime-unavailable';
        const privateReason =
            'stderr: secret details from /home/private/krdpserver';
        spyOn(localPlugin, '_runtimeCapabilities').and.returnValue({
            available: false,
            reason: privateReason,
            executable: null,
            capabilities: null,
        });
        spyOn(localPlugin, '_startSession');
        spyOn(localPlugin.device, 'sendPacket');
        spyOn(localPlugin.device, 'showNotification');
        markLan(localPlugin);

        localPlugin.handlePacket(request(sessionId));

        expect(localPlugin._startSession).not.toHaveBeenCalled();
        expect(localPlugin.device.showNotification).not.toHaveBeenCalled();
        expect(localPlugin.device.sendPacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: PACKET,
                body: jasmine.objectContaining({
                    action: 'status',
                    protocolVersion: 2,
                    sessionId,
                    status: 'failed',
                }),
            }));

        const status = localPlugin.device.sendPacket.calls
            .mostRecent().args[0];
        expect(status.body.message).not.toContain(privateReason);
        expect(status.body.message).not.toContain('/home/private');
    });

    it('does not advertise private runtime errors to the peer', function () {
        const privateReason =
            'stderr: secret details from /home/private/krdpserver';
        spyOn(localPlugin, '_runtimeCapabilities').and.returnValue({
            available: false,
            reason: privateReason,
            executable: null,
            capabilities: null,
        });
        spyOn(localPlugin, '_getMonitors').and.returnValue(MONITORS);
        spyOn(localPlugin.device, 'sendPacket');

        localPlugin._sendCapabilities();

        const capabilities = localPlugin.device.sendPacket.calls
            .mostRecent().args[0];
        expect(capabilities.body.remoteDesktopUnavailableReason)
            .not.toContain(privateReason);
        expect(capabilities.body.remoteDesktopUnavailableReason)
            .not.toContain('/home/private');
    });

    it('ignores lifecycle packets for a different session', function () {
        spyOn(localPlugin, '_stopSession').and.callThrough();

        localPlugin.handlePacket(packet(REQUEST_PACKET, {
            action: 'clientConnected',
            protocolVersion: 2,
            sessionId: 'not-the-current-session',
        }));
        localPlugin.handlePacket(packet(REQUEST_PACKET, {
            action: 'stop',
            protocolVersion: 2,
            sessionId: 'not-the-current-session',
        }));

        expect(localPlugin._stopSession).not.toHaveBeenCalled();
    });

    it('stops the matching session when the peer requests it', function () {
        const sessionId = 'peer-stops-session';
        localPlugin._currentRequest = {sessionId};
        spyOn(localPlugin, '_stopSession').and.callThrough();

        localPlugin.handlePacket(packet(REQUEST_PACKET, {
            action: 'stop',
            protocolVersion: 2,
            sessionId,
        }));

        expect(localPlugin._stopSession).toHaveBeenCalledOnceWith(true);
    });

    it('disables its GActions and tears down a session when disconnected', async function () {
        spyOn(localPlugin, '_stopSession').and.callThrough();

        await testRig.setConnected(false);

        expect(localPlugin._stopSession).toHaveBeenCalled();
        expect(localPlugin.device.get_action_enabled(
            'acceptRemoteDesktop')).toBeFalse();
        expect(localPlugin.device.get_action_enabled(
            'rejectRemoteDesktop')).toBeFalse();
        expect(localPlugin.device.get_action_enabled(
            'stopRemoteDesktop')).toBeFalse();
    });
});
