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
    incomingCapabilities: [],
    outgoingCapabilities: [],
    actions: {
        mirrorScreen: {
            label: _('Mirror Screen'),
            icon_name: 'preferences-desktop-display-symbolic',
            parameter_type: null,
        },
        stopMirroring: {
            label: _('Stop Mirroring'),
            icon_name: 'process-stop-symbolic',
            parameter_type: null,
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
        this._cancellable = null;
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

        if (host)
            args.push(`--tcpip=${host}:${adbPort}`);

        return args;
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
        if (this._isMirroring || this._subprocess)
            return;

        try {
            const argv = this._buildArguments();
            this._cancellable = new Gio.Cancellable();

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDERR_PIPE,
            });

            this._subprocess = launcher.spawnv(argv);
            this._setMirroringState(true);

            await this._waitSubprocessAsync(this._subprocess, this._cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                logError(e, `${this.device.name}: ScreenMirror failed`);
                this._notifyError(e.message);
            }
        } finally {
            this._cleanupProcess();
        }
    }

    _waitSubprocessAsync(subprocess, cancellable) {
        return new Promise((resolve, reject) => {
            subprocess.wait_check_async(cancellable, (proc, res) => {
                try {
                    proc.wait_check_finish(res);
                    resolve();
                } catch (e) {
                    const stderrStream = proc.get_stderr_pipe();
                    if (stderrStream) {
                        const dataStream = new Gio.DataInputStream({
                            base_stream: stderrStream,
                        });
                        const [line] = dataStream.read_line_utf8(null);
                        if (line) {
                            reject(new Error(line));
                            return;
                        }
                    }
                    reject(e);
                }
            });
        });
    }

    stopMirroring() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._subprocess) {
            this._subprocess.send_signal(15);
            this._cleanupProcess();
        }
    }

    _cleanupProcess() {
        this._subprocess = null;
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
        this.stopMirroring();
        super.destroy();
    }
});

export default ScreenMirrorPlugin;
