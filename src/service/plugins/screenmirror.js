// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import Plugin from '../plugin.js';

export const Metadata = {
    label: _('Screen Mirror'),
    description: _('Mirror device screen natively'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.ScreenMirror',
    localOnly: true,
    incomingCapabilities: [],
    outgoingCapabilities: [],
    actions: {
        mirrorScreen: {
            label: _('Mirror Screen'),
            icon_name: 'preferences-desktop-display-symbolic',
            parameter_type: null,
            incoming: [],
            outgoing: [],
        },
        stopMirroring: {
            label: _('Stop Mirroring'),
            icon_name: 'process-stop-symbolic',
            parameter_type: null,
            incoming: [],
            outgoing: [],
        },
    },
};

const ScreenMirrorPlugin = GObject.registerClass({
    GTypeName: 'GSConnectScreenMirrorPlugin',
    Properties: {
        'is-mirroring': GObject.ParamSpec.boolean(
            'is-mirroring',
            'Is Mirroring',
            'Whether a screen mirroring session is currently active',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
}, class ScreenMirrorPlugin extends Plugin {
    _init(device) {
        super._init(device, 'screenmirror');

        this._subprocess = null;
        this._stopRequested = false;
        this._destroyed = false;
        this._isMirroring = false;
        this._scrcpyPath = GLib.find_program_in_path('scrcpy');
    }

    get is_mirroring() {
        return this._isMirroring;
    }

    _setMirroringState(state) {
        if (this._isMirroring === state)
            return;

        this._isMirroring = state;
        this.notify('is-mirroring');
        this._syncActions();
    }

    _syncActions() {
        const startAction = this.device.lookup_action('mirrorScreen');
        const stopAction = this.device.lookup_action('stopMirroring');

        if (startAction)
            startAction.set_enabled(!this._isMirroring && this.device.connected);

        if (stopAction)
            stopAction.set_enabled(this._isMirroring);
    }

    connected() {
        super.connected();
        this._syncActions();
    }

    disconnected() {
        super.disconnected();
        this.stopMirroring();
        this._syncActions();
    }

    _buildArguments() {
        if (!this._scrcpyPath) {
            throw new Error(_('scrcpy runtime component missing. Please ensure scrcpy is installed on the host system.'));
        }

        const args = [
            this._scrcpyPath,
            `--window-title=${this.device.name}`,
        ];

        if (this.settings.get_boolean('turn-screen-off'))
            args.push('--turn-screen-off');

        if (this.settings.get_boolean('stay-awake'))
            args.push('--stay-awake');

        const host = this._getDeviceIpAddress();
        const adbPort = this.settings.get_uint('adb-port');

        if (host) {
            const serial = this._findAdbSerial(host);

            if (serial)
                args.push(`--serial=${serial}`);
            else
                args.push(`--tcpip=${host}:${adbPort}`);
        } else {
            throw new Error(_('Could not determine device IP address.'));
        }

        return args;
    }

    _findAdbSerial(host) {
        const adbPath = GLib.find_program_in_path('adb');

        if (!adbPath)
            throw new Error(_('ADB is not installed.'));

        const process = Gio.Subprocess.new(
            [adbPath, 'devices'],
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE
        );

        const [, stdout] = process.communicate_utf8(null, null);

        if (!process.get_successful())
            throw new Error(_('Could not list ADB devices.'));

        const matches = stdout.split('\n')
            .map(line => line.trim().split(/\s+/))
            .filter(([serial, state]) =>
                serial.startsWith(`${host}:`) && state === 'device');

        if (matches.length > 1)
            throw new Error(_('Multiple ADB connections match this device.'));

        return matches.length === 1 ? matches[0][0] : null;
    }

    _getDeviceIpAddress() {
        try {
            const channel = this.device._channel;
            if (channel && channel.host)
                return channel.host;
        } catch (e) {
            debug(e, this.device.name);
        }
        return null;
    }

    async mirrorScreen() {
        if (this._destroyed || this._isMirroring || this._subprocess)
            return;

        this._stopRequested = false;

        try {
            const argv = this._buildArguments();

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.NONE,
            });

            this._subprocess = launcher.spawnv(argv);
            this._setMirroringState(true);

            await this._subprocess.wait_check_async(null);
        } catch (e) {
            if (!this._stopRequested && !this._destroyed) {
                logError(e, `${this.device.name}: ScreenMirror failed`);
                this._notifyError(e.message);
            }
        } finally {
            this._cleanupProcess();
        }
    }

    stopMirroring() {
        if (!this._subprocess || this._stopRequested)
            return;

        this._stopRequested = true;
        this._subprocess.send_signal(15);
    }

    _cleanupProcess() {
        this._subprocess = null;
        this._stopRequested = false;

        if (!this._destroyed)
            this._setMirroringState(false);
    }

    _notifyError(message) {
        this.device.showNotification({
            id: 'screenmirror-error',
            title: _('%s: Screen Mirroring Failed').format(this.device.name),
            body: message,
            icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
        });
    }

    destroy() {
        this._destroyed = true;
        this.stopMirroring();
        super.destroy();
    }
});

export default ScreenMirrorPlugin;
