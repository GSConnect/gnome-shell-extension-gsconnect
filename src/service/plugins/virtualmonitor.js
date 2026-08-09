// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import Plugin from '../plugin.js';


const PACKET_TYPE = 'kdeconnect.virtualmonitor';
const REQUEST_PACKET_TYPE = 'kdeconnect.virtualmonitor.request';
const PROTOCOL_VERSION = 2;
const RUNTIME_API_VERSION = 1;
const RDP_PORT_MIN = 1716;
const RDP_PORT_MAX = 1764;
const RUNTIME_PROBE_TIMEOUT_MS = 3000;
const PERMISSION_TIMEOUT_SECONDS = 30;
const SERVER_PROBE_ATTEMPTS = 50;
const SERVER_PROBE_INTERVAL_MS = 100;
const CLIENT_TIMEOUT_SECONDS = 45;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_DIAGNOSTIC_ENTRIES = 50;
const MAX_DIAGNOSTIC_LENGTH = 500;
const MAX_STDERR_LENGTH = 64 * 1024;
const PUBLIC_UNAVAILABLE_REASON =
    _('Remote desktop is unavailable on this computer.');


export const Metadata = {
    label: _('Remote Desktop'),
    description: _('Share a monitor or a new virtual monitor over RDP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.VirtualMonitor',
    incomingCapabilities: [PACKET_TYPE, REQUEST_PACKET_TYPE],
    outgoingCapabilities: [PACKET_TYPE, REQUEST_PACKET_TYPE],
    actions: {
        acceptRemoteDesktop: {
            label: _('Allow Remote Desktop'),
            icon_name: 'computer-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [REQUEST_PACKET_TYPE],
            outgoing: [PACKET_TYPE],
        },
        rejectRemoteDesktop: {
            label: _('Deny Remote Desktop'),
            icon_name: 'action-unavailable-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [REQUEST_PACKET_TYPE],
            outgoing: [PACKET_TYPE],
        },
        stopRemoteDesktop: {
            label: _('Stop Remote Desktop'),
            icon_name: 'media-playback-stop-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [REQUEST_PACKET_TYPE],
            outgoing: [PACKET_TYPE],
        },
        revokeRemoteDesktop: {
            label: _('Revoke Remote Desktop Access'),
            icon_name: 'changes-prevent-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: [],
        },
    },
};


/**
 * Clamp an untrusted numeric packet field.
 *
 * @param {*} value - The packet value
 * @param {number} fallback - Value used for non-finite input
 * @param {number} minimum - Minimum value
 * @param {number} maximum - Maximum value
 * @returns {number} The validated number
 */
function clampNumber(value, fallback, minimum, maximum) {
    value = Number(value);

    if (!Number.isFinite(value))
        return fallback;

    return Math.min(maximum, Math.max(minimum, value));
}


/**
 * Check whether a parsed JSON value is an object with named properties.
 *
 * @param {*} value - The value to check
 * @returns {boolean} Whether the value is a JSON object
 */
function isJsonObject(value) {
    return typeof value === 'object' && value !== null &&
        !Array.isArray(value);
}


/**
 * Remove one-time credentials from text before it reaches the journal.
 *
 * @param {*} value - Untrusted diagnostic text
 * @param {string[]} secrets - Exact values which must not be logged
 * @returns {string} Redacted text
 */
function redactSecrets(value, secrets = []) {
    let output = String(value ?? '');
    const candidates = [...new Set(secrets.filter(secret =>
        typeof secret === 'string' && secret.length > 0))]
        .sort((a, b) => b.length - a.length);

    for (const secret of candidates)
        output = output.replaceAll(secret, '[redacted]');

    // These are the formats used by our generated password and certificate
    // fingerprint. This fallback also covers delayed peer diagnostics received
    // after the in-memory credentials have already been cleared.
    return output
        .replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted]')
        .replace(/\b[0-9a-fA-F]{32}\b/g, '[redacted]');
}


/**
 * Run the side-effect-free KRdp capability command with a hard timeout.
 *
 * A nested main loop keeps the public preflight API synchronous while still
 * allowing Gio to cancel and kill a wedged executable.
 *
 * @param {string} executable - Absolute krdpserver path
 * @returns {object} Captured process result
 */
function probeRuntime(executable) {
    const process = Gio.Subprocess.new(
        [executable, '--capabilities-json'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    const cancellable = new Gio.Cancellable();
    const loop = GLib.MainLoop.new(null, false);
    let stdout = '';
    let stderr = '';
    let error = null;
    let timedOut = false;
    let timeoutId = 0;

    timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        RUNTIME_PROBE_TIMEOUT_MS,
        () => {
            timeoutId = 0;
            timedOut = true;
            cancellable.cancel();

            try {
                process.force_exit();
            } catch {
            }

            return GLib.SOURCE_REMOVE;
        }
    );

    process.communicate_utf8_async(null, cancellable, (proc, result) => {
        try {
            [, stdout, stderr] = proc.communicate_utf8_finish(result);
        } catch (e) {
            error = e;
        }

        if (timeoutId !== 0) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }

        loop.quit();
    });
    loop.run();

    return {
        error,
        stderr,
        stdout,
        successful: !timedOut && error === null && process.get_successful(),
        timedOut,
    };
}


/**
 * KDE Connect virtual-monitor protocol-v2 exporter for GNOME.
 */
const VirtualMonitorPlugin = GObject.registerClass({
    GTypeName: 'GSConnectVirtualMonitorPlugin',
}, class VirtualMonitorPlugin extends Plugin {

    _init(device) {
        super._init(device, 'virtualmonitor');

        this._runtimeExecutable = undefined;
        this._runtimeResolutionError = '';
        this._pendingRequest = null;
        this._currentRequest = null;
        this._process = null;
        this._serverReady = false;
        this._clientConnected = false;
        this._sessionGeneration = 0;
        this._permissionTimeoutId = 0;
        this._serverProbeId = 0;
        this._serverProbeCancellable = null;
        this._clientTimeoutId = 0;
        this._tlsCredentials = null;
        this._port = 0;
        this._username = '';
        this._password = '';

        this._permissionChangedId = this.settings.connect(
            'changed::remote-desktop-certificate',
            this._onPermissionChanged.bind(this)
        );
        this._certificateChangedId = this.device.settings.connect(
            'changed::certificate-pem',
            this._onPairedCertificateChanged.bind(this)
        );
    }

    connected() {
        super.connected();

        const stored = this.settings.get_string('remote-desktop-certificate');

        if (stored !== '' && !this._hasRemoteDesktopPermission())
            this.settings.set_string('remote-desktop-certificate', '');

        this._sendCapabilities();
    }

    disconnected() {
        this._stopSession(false, true);
        super.disconnected();
    }

    handlePacket(packet) {
        if (packet.type === REQUEST_PACKET_TYPE) {
            this._handleRequestPacket(packet.body ?? {});
            return;
        }

        if (packet.type === PACKET_TYPE)
            this._handleStatusPacket(packet.body ?? {});
    }

    _handleRequestPacket(body) {
        switch (body.action) {
            case 'requestCapabilities':
                this._sendCapabilities();
                break;

            case 'request':
                this._handleSessionRequest(body);
                break;

            case 'clientConnected':
                if (body.protocolVersion !== PROTOCOL_VERSION)
                    break;

                if (this._isValidSessionId(body.sessionId) &&
                    this._currentRequest?.sessionId === body.sessionId &&
                    this._serverReady) {
                    this._clientConnected = true;
                    this._clearSource('_clientTimeoutId');
                    this._sendStatus('connected');
                }
                break;

            case 'stop': {
                if (body.protocolVersion !== PROTOCOL_VERSION)
                    break;

                const pending = this._pendingRequest?.sessionId;
                const current = this._currentRequest?.sessionId;

                if (this._isValidSessionId(body.sessionId) &&
                    (body.sessionId === pending || body.sessionId === current))
                    this._stopSession(true);
                break;
            }

            // GSConnect currently exports RDP but does not launch an RDP
            // client for a remote exporter.
            case 'connect':
                break;

            default:
                debug(`Unsupported virtual monitor action: ${body.action}`,
                    this.device.name);
        }
    }

    _handleStatusPacket(body) {
        if (body.action !== 'diagnostic' || !Array.isArray(body.entries))
            return;

        const sessionId = this._isValidSessionId(body.sessionId)
            ? body.sessionId.substring(0, 8)
            : 'none';
        const entries = body.entries.slice(0, MAX_DIAGNOSTIC_ENTRIES);

        for (const entry of entries) {
            if (typeof entry !== 'string')
                continue;

            const sanitized = redactSecrets(
                entry.substring(0, MAX_DIAGNOSTIC_LENGTH)
                    .replace(/[\x00-\x1f\x7f]/g, ' '),
                [this._password, this._tlsCredentials?.fingerprint]
            );

            debug(`Android RDP diagnostic ${sessionId}: ${sanitized}`,
                this.device.name);
        }
    }

    _handleSessionRequest(body) {
        const sessionId = body.sessionId;

        if (body.protocolVersion !== PROTOCOL_VERSION) {
            if (this._isValidSessionId(sessionId)) {
                this._sendStatusForSession(
                    sessionId,
                    'failed',
                    _('The remote desktop protocol version is unsupported.')
                );
            }
            return;
        }

        if (!this._isValidSessionId(sessionId)) {
            debug('Ignored a remote desktop request with an unsafe session identifier',
                this.device.name);
            return;
        }

        if (this._pendingRequest !== null) {
            if (sessionId === this._pendingRequest.sessionId) {
                this._sendStatusForSession(
                    sessionId,
                    'awaitingPermission',
                    _('Waiting for remote desktop permission on the computer.')
                );
            } else {
                this._sendStatusForSession(
                    sessionId,
                    'failed',
                    _('Another remote desktop request is awaiting permission.')
                );
            }
            return;
        }

        if (this._currentRequest !== null || this._process !== null) {
            if (sessionId !== this._currentRequest?.sessionId) {
                this._sendStatusForSession(
                    sessionId,
                    'failed',
                    _('Another remote desktop session is already active.')
                );
            } else if (this._serverReady) {
                this._sendConnectionInfo();
            } else {
                this._sendStatus('starting');
            }
            return;
        }

        const runtime = this._runtimeCapabilities();

        if (!runtime.available) {
            this._sendStatusForSession(
                sessionId,
                'failed',
                PUBLIC_UNAVAILABLE_REASON
            );
            return;
        }

        const request = this._parseSessionRequest(body);

        if (request === null) {
            this._sendStatusForSession(
                sessionId,
                'failed',
                _('The requested remote desktop mode is unsupported.')
            );
            return;
        }

        if (!this._hasRemoteDesktopPermission()) {
            this._requestRemoteDesktopPermission(request);
            return;
        }

        this._startSession(request);
    }

    _parseSessionRequest(body) {
        const quality = Math.round(clampNumber(body.quality, 70, 0, 100));

        if (body.mode === 'virtualMonitor') {
            return {
                sessionId: body.sessionId,
                mode: body.mode,
                width: Math.round(clampNumber(body.width, 1280, 320, 7680)),
                height: Math.round(clampNumber(body.height, 720, 240, 4320)),
                scale: clampNumber(body.scale, 1, 0.5, 4),
                quality,
            };
        }

        if (body.mode === 'monitor') {
            const monitors = this._getMonitors();
            const monitorIndex = Math.trunc(Number(body.monitorIndex ?? 0));

            if (!Number.isFinite(monitorIndex) || monitorIndex < 0 ||
                monitorIndex >= monitors.length) {
                return null;
            }

            return {
                sessionId: body.sessionId,
                mode: body.mode,
                monitorIndex,
                quality,
            };
        }

        return null;
    }

    _requestRemoteDesktopPermission(request) {
        this._clearPermissionRequest();
        this._pendingRequest = request;

        this._sendStatusForSession(
            request.sessionId,
            'awaitingPermission',
            _('Waiting for remote desktop permission on the computer.')
        );

        this.device.showNotification({
            id: 'remote-desktop-permission',
            title: _('Remote Desktop Access Request'),
            body: _('%s wants to view and control this computer. Allowing access shares the screen and permits mouse and keyboard input.').format(
                this.device.name),
            icon: new Gio.ThemedIcon({name: 'computer-symbolic'}),
            priority: Gio.NotificationPriority.URGENT,
            buttons: [
                {
                    action: 'rejectRemoteDesktop',
                    label: _('Deny'),
                    parameter: new GLib.Variant('s', request.sessionId),
                },
                {
                    action: 'acceptRemoteDesktop',
                    label: _('Allow'),
                    parameter: new GLib.Variant('s', request.sessionId),
                },
            ],
        });

        this._permissionTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            PERMISSION_TIMEOUT_SECONDS,
            () => {
                this._permissionTimeoutId = 0;
                this.rejectRemoteDesktop(
                    request.sessionId,
                    _('The remote desktop permission request timed out.')
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    acceptRemoteDesktop(sessionId) {
        if (this._pendingRequest?.sessionId !== sessionId)
            return;

        const certificate = this._pairedCertificateFingerprint();

        if (certificate === '') {
            this.rejectRemoteDesktop(
                sessionId,
                _('The paired device identity could not be verified.')
            );
            return;
        }

        const request = this._pendingRequest;
        this._clearPermissionRequest();
        this.settings.set_string('remote-desktop-certificate', certificate);
        this._startSession(request);
    }

    rejectRemoteDesktop(sessionId, message = null) {
        if (this._pendingRequest?.sessionId !== sessionId)
            return;

        this._clearPermissionRequest();
        this._sendStatusForSession(
            sessionId,
            'failed',
            message ?? _('Remote desktop access was denied on the computer.')
        );
    }

    stopRemoteDesktop(sessionId) {
        const pending = this._pendingRequest?.sessionId;
        const current = this._currentRequest?.sessionId;

        if (sessionId === null || sessionId === '' ||
            sessionId === pending || sessionId === current)
            this._stopSession(true, true);
    }

    revokeRemoteDesktop() {
        this.settings.set_string('remote-desktop-certificate', '');
    }

    _onPermissionChanged() {
        if (this._hasRemoteDesktopPermission())
            return;

        if (this._pendingRequest !== null || this._currentRequest !== null ||
            this._process !== null) {
            const sessionId = this._pendingRequest?.sessionId ??
                this._currentRequest?.sessionId;
            this._stopSession(false, true);

            if (sessionId) {
                this._sendStatusForSession(
                    sessionId,
                    'stopped',
                    _('Remote desktop access was revoked on the computer.')
                );
            }
        }
    }

    _onPairedCertificateChanged() {
        const stored = this.settings.get_string(
            'remote-desktop-certificate');

        if (stored !== '' && !this._hasRemoteDesktopPermission())
            this.settings.set_string('remote-desktop-certificate', '');
    }

    _isValidSessionId(sessionId) {
        return typeof sessionId === 'string' &&
            sessionId.length <= MAX_SESSION_ID_LENGTH &&
            /^[\x21-\x7e]+$/.test(sessionId);
    }

    _hasRemoteDesktopPermission() {
        const certificate = this._pairedCertificateFingerprint();

        return certificate !== '' &&
            certificate === this.settings.get_string(
                'remote-desktop-certificate');
    }

    _pairedCertificateFingerprint() {
        const certificatePem = this.device.settings.get_string(
            'certificate-pem');

        if (certificatePem === '')
            return '';

        const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
        checksum.update(new TextEncoder().encode(certificatePem));

        return checksum.get_string();
    }

    _clearPermissionRequest() {
        this._clearSource('_permissionTimeoutId');
        this.device.hideNotification('remote-desktop-permission');
        this._pendingRequest = null;
    }

    _sendCapabilities() {
        const runtime = this._runtimeCapabilities();
        const monitors = this._getMonitors();

        this.device.sendPacket({
            type: PACKET_TYPE,
            body: {
                protocolVersion: PROTOCOL_VERSION,
                action: 'capabilities',
                resolutions: monitors.map(monitor => ({
                    resolution: `${monitor.width}x${monitor.height}`,
                    scale: monitor.scale,
                })),
                monitors,
                supports_rdp: false,
                supports_virt_mon: runtime.available,
                supports_remote_desktop: runtime.available,
                remoteDesktopUnavailableReason: runtime.available
                    ? ''
                    : PUBLIC_UNAVAILABLE_REASON,
                sessionModes: ['monitor', 'virtualMonitor'],
                rdpFeatures: {
                    graphicsPipeline: true,
                    h264: true,
                    progressive: true,
                    nla: false,
                    tls: true,
                    tlsFingerprint: true,
                },
            },
        });
    }

    _runtimeCapabilities() {
        const unavailable = reason => ({
            available: false,
            reason,
            executable: this._runtimeExecutable ?? null,
            capabilities: null,
        });
        const executable = this._resolveRuntimeExecutable();

        if (executable === null) {
            return unavailable(this._runtimeResolutionError ||
                _('The private KRdp runtime is not installed.'));
        }

        let probe;

        try {
            probe = probeRuntime(executable);
        } catch (e) {
            return unavailable(
                _('The KRdp runtime could not be started: %s').format(e.message));
        }

        if (probe.timedOut)
            return unavailable(_('The KRdp compatibility check timed out.'));

        if (!probe.successful) {
            const detail = probe.error?.message || probe.stderr.trim();
            return unavailable(detail
                ? _('The KRdp compatibility check failed: %s').format(
                    detail.substring(0, 300))
                : _('The KRdp compatibility check failed.'));
        }

        let capabilities;

        try {
            capabilities = JSON.parse(probe.stdout);
        } catch {
            return unavailable(
                _('The KRdp runtime returned invalid capability data.'));
        }

        if (!isJsonObject(capabilities)) {
            return unavailable(
                _('The KRdp runtime returned invalid capability data.'));
        }

        const modes = capabilities.sessionModes;
        const compatible = capabilities.apiVersion === RUNTIME_API_VERSION &&
            capabilities.virtualMonitorRequestedSize === true &&
            capabilities.passwordFd === true &&
            capabilities.listenAddress === true &&
            capabilities.tls === true &&
            Array.isArray(modes) && modes.includes('monitor') &&
            modes.includes('virtualMonitor');

        if (!compatible) {
            return unavailable(
                _('The installed KRdp runtime does not provide the required GSConnect API.'));
        }

        const sessionType = GLib.getenv('XDG_SESSION_TYPE')?.toLowerCase();
        const waylandDisplay = GLib.getenv('WAYLAND_DISPLAY');

        if (sessionType !== 'wayland' && !waylandDisplay) {
            return unavailable(
                _('Remote desktop export requires a Wayland session.'));
        }

        try {
            Gio.bus_get_sync(Gio.BusType.SESSION, null);
        } catch {
            return unavailable(
                _('Remote desktop export requires a working session bus.'));
        }

        if (this._getMonitors().length === 0) {
            return unavailable(
                _('Remote desktop export requires an active display.'));
        }

        const localHost = this._getLocalHost();

        if (localHost === null) {
            return unavailable(
                _('Remote desktop export requires a direct local network connection.'));
        }

        if (this._findAvailablePort(localHost) === 0) {
            return unavailable(
                _('No local TCP port is available for the RDP server.'));
        }

        return {
            available: true,
            reason: '',
            executable,
            capabilities,
        };
    }

    _resolveRuntimeExecutable() {
        const override = GLib.getenv('GSCONNECT_KRDP_SERVER')?.trim();
        const bundled = GLib.build_filenamev([
            Config.PACKAGE_DATADIR,
            'runtime',
            'krdp',
            'bin',
            'krdpserver',
        ]);
        const candidates = [];

        if (override) {
            candidates.push(override);
        } else {
            candidates.push(bundled);

            const system = GLib.find_program_in_path('krdpserver');

            if (system !== null)
                candidates.push(system);
        }

        for (let candidate of candidates) {
            candidate = GLib.canonicalize_filename(
                candidate,
                GLib.get_current_dir()
            );

            if (GLib.file_test(candidate, GLib.FileTest.IS_REGULAR) &&
                GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) {
                this._runtimeExecutable = candidate;
                return candidate;
            }
        }

        // Do not cache a miss: a bundle may be installed, or an override may
        // be corrected, while the service is still running.
        this._runtimeExecutable = undefined;
        this._runtimeResolutionError = override
            ? _('GSCONNECT_KRDP_SERVER does not name an executable file.')
            : _('The private KRdp runtime is not installed.');

        return null;
    }

    _getMonitors() {
        const display = Gdk.Display.get_default();

        if (display === null)
            return [];

        const monitors = [];
        const primary = display.get_primary_monitor();

        for (let index = 0; index < display.get_n_monitors(); index++) {
            const monitor = display.get_monitor(index);
            const geometry = monitor.get_geometry();
            const scale = monitor.get_scale_factor();
            const model = monitor.get_model();

            monitors.push({
                index,
                name: model || _('Monitor %d').format(index + 1),
                width: geometry.width * scale,
                height: geometry.height * scale,
                scale,
                primary: monitor === primary,
            });
        }

        return monitors;
    }

    _getLocalHost() {
        if (this.device.connection_type !== 'lan')
            return null;

        const host = this.device.channel?.local_host;

        if (typeof host !== 'string' || host.length === 0)
            return null;

        return Gio.InetAddress.new_from_string(host) === null ? null : host;
    }

    _findAvailablePort(localHost) {
        const inetAddress = Gio.InetAddress.new_from_string(localHost);

        if (inetAddress === null)
            return 0;

        for (let port = RDP_PORT_MAX; port >= RDP_PORT_MIN; port--) {
            let socket = null;

            try {
                socket = Gio.Socket.new(
                    inetAddress.get_family(),
                    Gio.SocketType.STREAM,
                    Gio.SocketProtocol.TCP
                );
                const address = Gio.InetSocketAddress.new(inetAddress, port);
                socket.bind(address, false);
                socket.close();
                return port;
            } catch {
                try {
                    socket?.close();
                } catch {
                }
            }
        }

        return 0;
    }

    _startSession(request) {
        const runtime = this._runtimeCapabilities();

        if (!runtime.available) {
            this._sendStatusForSession(
                request.sessionId,
                'failed',
                PUBLIC_UNAVAILABLE_REASON
            );
            return false;
        }

        const localHost = this._getLocalHost();
        const port = localHost === null ? 0 : this._findAvailablePort(localHost);

        if (localHost === null || port === 0) {
            this._sendStatusForSession(
                request.sessionId,
                'failed',
                _('No local TCP port is available for the RDP server.')
            );
            return false;
        }

        this._stopSession(false, true);
        this._currentRequest = request;
        this._port = port;
        this._username = 'gsconnect';
        this._password = GLib.uuid_string_random().replaceAll('-', '');
        this._serverReady = false;
        this._clientConnected = false;

        try {
            this._tlsCredentials = this._createTlsCredentials();

            const args = [runtime.executable];

            if (request.mode === 'virtualMonitor') {
                args.push(
                    '--virtual-monitor',
                    `${request.width}x${request.height}@${request.scale}`
                );
            } else {
                args.push('--monitor', `${request.monitorIndex}`);
            }

            args.push(
                '--address', localHost,
                '--port', `${port}`,
                '--username', this._username,
                '--password-fd', '0',
                '--certificate', this._tlsCredentials.certificate,
                '--certificate-key', this._tlsCredentials.key,
                '--quality', `${request.quality}`
            );

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            const stateDirectory = GLib.build_filenamev([
                Config.CONFIGDIR,
                'krdp-state',
                this.device.id,
            ]);
            GLib.mkdir_with_parents(stateDirectory, 0o700);
            launcher.setenv('XDG_STATE_HOME', stateDirectory, true);
            launcher.setenv('XDG_CONFIG_HOME', stateDirectory, true);

            const generation = ++this._sessionGeneration;
            const process = launcher.spawnv(args);
            const redactions = [
                this._password,
                this._tlsCredentials.fingerprint,
                this._tlsCredentials.certificate,
                this._tlsCredentials.key,
            ];
            this._process = process;

            this._writeProcessPassword(process, this._password);
            Promise.all([
                this._waitForProcess(process),
                this._readProcessStderr(process),
            ]).then(([, stderr]) => {
                this._onProcessFinished(
                    process,
                    generation,
                    stderr,
                    redactions
                );
            }).catch(e => {
                this._onProcessFinished(
                    process,
                    generation,
                    e.message,
                    redactions
                );
            });

            this._sendStatus('starting');
            this._probeServer(generation, localHost);
            return true;
        } catch (e) {
            debug(`Could not start KRdp: ${redactSecrets(e.message, [
                this._password,
                this._tlsCredentials?.fingerprint,
            ])}`, this.device.name);
            this._failCurrentSession(_('The RDP server could not be started.'));
            return false;
        }
    }

    _writeProcessPassword(process, password) {
        const stream = process.get_stdin_pipe();
        const bytes = new TextEncoder().encode(password);

        stream.write_all_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            null
        ).then(() => stream.close_async(GLib.PRIORITY_DEFAULT, null))
            .catch(() => {
                try {
                    process.force_exit();
                } catch {
                }
            })
            .finally(() => bytes.fill(0));
    }

    _waitForProcess(process) {
        return new Promise((resolve, reject) => {
            process.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _readProcessStderr(process) {
        const stream = process.get_stderr_pipe();
        const decoder = new TextDecoder();
        let output = '';

        return new Promise(resolve => {
            const read = () => {
                stream.read_bytes_async(
                    4096,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (input, result) => {
                        try {
                            const bytes = input.read_bytes_finish(result);

                            if (bytes.get_size() === 0) {
                                output += decoder.decode();
                                resolve(output);
                                return;
                            }

                            output += decoder.decode(bytes.toArray(), {
                                stream: true,
                            });

                            if (output.length > MAX_STDERR_LENGTH) {
                                output = output.substring(
                                    output.length - MAX_STDERR_LENGTH
                                );
                            }

                            read();
                        } catch {
                            resolve(output);
                        }
                    }
                );
            };

            read();
        });
    }

    _createTlsCredentials() {
        let directory = null;

        try {
            directory = GLib.Dir.make_tmp('gsconnect-rdp.XXXXXX');
            const certificate = GLib.build_filenamev([
                directory,
                'server.crt',
            ]);
            const key = GLib.build_filenamev([directory, 'server.key']);
            const openssl = this._resolveOpenSSL();

            if (openssl === null)
                throw new Error(_('OpenSSL is not installed.'));

            const create = Gio.Subprocess.new([
                openssl,
                'req',
                '-newkey', 'rsa:2048',
                '-keyout', key,
                '-new', '-x509', '-nodes', '-sha256',
                '-days', '1',
                '-subj', '/O=GSConnect/CN=GSConnect RDP',
                '-out', certificate,
            ], Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            create.wait_check(null);

            GLib.chmod(key, 0o600);
            GLib.chmod(certificate, 0o600);

            const convert = Gio.Subprocess.new([
                openssl,
                'x509',
                '-in', certificate,
                '-outform', 'DER',
            ], Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            const der = convert.communicate(null, null)[1];

            if (!convert.get_successful() || der === null)
                throw new Error(_('Could not read the RDP TLS certificate.'));

            const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
            checksum.update(der.toArray());

            return {
                directory,
                certificate,
                key,
                fingerprint: checksum.get_string(),
            };
        } catch (e) {
            if (directory !== null)
                this._removeTlsDirectory(directory);

            throw e;
        }
    }

    _resolveOpenSSL() {
        if (GLib.path_is_absolute(Config.OPENSSL_PATH)) {
            return GLib.file_test(
                Config.OPENSSL_PATH,
                GLib.FileTest.IS_EXECUTABLE
            ) ? Config.OPENSSL_PATH : null;
        }

        return GLib.find_program_in_path(Config.OPENSSL_PATH);
    }

    _probeServer(generation, localHost) {
        let attempts = SERVER_PROBE_ATTEMPTS;
        const inetAddress = Gio.InetAddress.new_from_string(localHost);
        const address = Gio.InetSocketAddress.new(inetAddress, this._port);
        const cancellable = new Gio.Cancellable();

        this._cancelServerProbe();
        this._serverProbeCancellable = cancellable;

        const isCurrent = () =>
            this._serverProbeCancellable === cancellable &&
            generation === this._sessionGeneration &&
            this._process !== null;

        const finish = () => {
            if (this._serverProbeCancellable === cancellable)
                this._serverProbeCancellable = null;
        };

        const attempt = async () => {
            if (!isCurrent()) {
                finish();
                return;
            }

            attempts--;
            const client = new Gio.SocketClient({enable_proxy: false});
            let connection = null;

            try {
                connection = await client.connect_async(address, cancellable);
            } catch {
            }

            if (!isCurrent()) {
                try {
                    connection?.close(null);
                } catch {
                }

                finish();
                return;
            }

            if (connection !== null) {
                connection.close(null);
                finish();
                this._serverReady = true;
                this._sendConnectionInfo();
                this._startClientTimeout(generation);
                return;
            }

            if (attempts <= 0) {
                finish();
                this._failCurrentSession(
                    _('The RDP server did not become ready in time.'));
                return;
            }

            this._serverProbeId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                SERVER_PROBE_INTERVAL_MS,
                () => {
                    this._serverProbeId = 0;
                    runAttempt();
                    return GLib.SOURCE_REMOVE;
                }
            );
        };

        const runAttempt = () => {
            attempt().catch(() => {
                if (!isCurrent()) {
                    finish();
                    return;
                }

                finish();
                this._failCurrentSession(
                    _('The RDP server did not become ready in time.'));
            });
        };

        runAttempt();
    }

    _cancelServerProbe() {
        this._clearSource('_serverProbeId');

        if (this._serverProbeCancellable !== null) {
            this._serverProbeCancellable.cancel();
            this._serverProbeCancellable = null;
        }
    }

    _startClientTimeout(generation) {
        this._clearSource('_clientTimeoutId');
        this._clientTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            CLIENT_TIMEOUT_SECONDS,
            () => {
                this._clientTimeoutId = 0;

                if (generation === this._sessionGeneration &&
                    this._serverReady && !this._clientConnected) {
                    this._failCurrentSession(
                        _('The remote RDP client did not connect in time.'));
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _onProcessFinished(process, generation, stderr, redactions = []) {
        if (generation !== this._sessionGeneration ||
            process !== this._process) {
            return;
        }

        const rawOutput = String(stderr ?? '');
        const output = redactSecrets(rawOutput.substring(
            Math.max(0, rawOutput.length - MAX_STDERR_LENGTH)
        ).trim(), redactions);

        if (output !== '')
            debug(`KRdp: ${output}`, this.device.name);

        this._process = null;
        this._failCurrentSession(
            _('The RDP server stopped unexpectedly.'));
    }

    _sendConnectionInfo() {
        if (this._currentRequest === null || this._tlsCredentials === null)
            return;

        this.device.sendPacket({
            type: REQUEST_PACKET_TYPE,
            body: {
                protocolVersion: PROTOCOL_VERSION,
                action: 'connect',
                sessionId: this._currentRequest.sessionId,
                protocol: 'rdp',
                username: this._username,
                password: this._password,
                port: this._port,
                certificateFingerprint: this._tlsCredentials.fingerprint,
                certificateHash: 'sha256',
                security: 'tls',
                status: 'ready',
                rdpFeatures: {
                    graphicsPipeline: true,
                    h264: true,
                    progressive: true,
                    nla: false,
                    tls: true,
                },
            },
        });

        this.device.showNotification({
            id: 'remote-desktop-active',
            title: _('Remote Desktop Is Active'),
            body: _('%s can view and control this computer.').format(
                this.device.name),
            icon: new Gio.ThemedIcon({name: 'computer-symbolic'}),
            priority: Gio.NotificationPriority.HIGH,
            buttons: [
                {
                    action: 'stopRemoteDesktop',
                    label: _('Stop'),
                    parameter: new GLib.Variant(
                        's',
                        this._currentRequest.sessionId
                    ),
                },
                {
                    action: 'revokeRemoteDesktop',
                    label: _('Revoke Access'),
                    parameter: null,
                },
            ],
        });
    }

    _sendStatus(status, message = null) {
        if (this._currentRequest !== null) {
            this._sendStatusForSession(
                this._currentRequest.sessionId,
                status,
                message
            );
        }
    }

    _sendStatusForSession(sessionId, status, message = null) {
        if (!this._isValidSessionId(sessionId))
            return;

        const body = {
            protocolVersion: PROTOCOL_VERSION,
            action: 'status',
            sessionId,
            status,
            active: this._process !== null,
        };

        if (message)
            body.message = message;

        this.device.sendPacket({type: PACKET_TYPE, body});
    }

    _failCurrentSession(message) {
        const sessionId = this._currentRequest?.sessionId;
        this._stopSession(false, true);

        if (sessionId)
            this._sendStatusForSession(sessionId, 'failed', message);
    }

    _stopSession(notifyPeer = false, force = true) {
        const sessionId = this._pendingRequest?.sessionId ??
            this._currentRequest?.sessionId;
        const hadSession = sessionId !== undefined || this._process !== null;
        const process = this._process;

        this._sessionGeneration++;
        this._clearPermissionRequest();
        this._cancelServerProbe();
        this._clearSource('_clientTimeoutId');
        this._process = null;
        this._serverReady = false;
        this._clientConnected = false;
        this._currentRequest = null;
        this._port = 0;
        this._username = '';
        this._password = '';

        if (process !== null) {
            try {
                if (force) {
                    process.force_exit();
                } else {
                    process.send_signal(15);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        try {
                            process.force_exit();
                        } catch {
                        }

                        return GLib.SOURCE_REMOVE;
                    });
                }
            } catch {
            }
        }

        this._cleanupTlsCredentials();
        this.device.hideNotification('remote-desktop-active');

        if (notifyPeer && hadSession && sessionId) {
            this._sendStatusForSession(
                sessionId,
                'stopped'
            );
        }
    }

    _cleanupTlsCredentials() {
        if (this._tlsCredentials === null)
            return;

        this._removeTlsDirectory(this._tlsCredentials.directory);
        this._tlsCredentials = null;
    }

    _removeTlsDirectory(directory) {
        const parent = Gio.File.new_for_path(directory);

        for (const name of ['server.crt', 'server.key']) {
            try {
                parent.get_child(name).delete(null);
            } catch {
            }
        }

        try {
            parent.delete(null);
        } catch {
        }
    }

    _clearSource(property) {
        if (this[property] !== 0) {
            GLib.source_remove(this[property]);
            this[property] = 0;
        }
    }

    destroy() {
        if (!this.device.paired)
            this.settings.set_string('remote-desktop-certificate', '');

        this.settings.disconnect(this._permissionChangedId);
        this.device.settings.disconnect(this._certificateChangedId);
        this._stopSession(false, true);
        super.destroy();
    }
});

export default VirtualMonitorPlugin;
