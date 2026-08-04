// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Core from '../core.js';
import Plugin from '../plugin.js';

// Import GStreamer
let Gst = null;
try {
    Gst = (await import('gi://Gst')).default;
    Gst.init(null);
} catch (e) {
    console.error('VirtualCamera: GStreamer not available:', e);
}


export const Metadata = {
    label: 'Virtual Camera',
    description: 'Use your phone camera as a webcam',
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.VirtualCamera',
    incomingCapabilities: ['kdeconnect.virtualcamera'],
    outgoingCapabilities: ['kdeconnect.virtualcamera.request'],
    actions: {
        startCamera: {
            label: 'Start Camera',
            icon_name: 'camera-video-symbolic',
            incoming: [],
            outgoing: ['kdeconnect.virtualcamera.request'],
            parameter_type: null,
        },
        stopCamera: {
            label: 'Stop Camera',
            icon_name: 'media-playback-stop-symbolic',
            incoming: [],
            outgoing: ['kdeconnect.virtualcamera.request'],
            parameter_type: null,
        },
    },
};


/**
 * Virtual Camera Plugin
 *
 * Receives video stream from phone camera and pipes to PipeWire
 * as a virtual webcam source using GStreamer.
 */
const VirtualCameraPlugin = GObject.registerClass({
    GTypeName: 'GSConnectVirtualCameraPlugin',
    Properties: {
        'streaming': GObject.ParamSpec.boolean(
            'streaming',
            'Streaming',
            'Whether camera is currently streaming',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
}, class VirtualCameraPlugin extends Plugin {

    _init(device) {
        super._init(device, 'virtualcamera');

        this._streaming = false;
        this._pipeline = null;
        this._appsrc = null;
        this._cancellable = null;
        this._width = 1280;
        this._height = 720;
        this._fps = 24;  // Fixed 24fps for optimal performance
    }

    get streaming() {
        return this._streaming;
    }

    connected() {
        super.connected();
    }

    disconnected() {
        super.disconnected();
        this._stopPipeline();
    }

    handlePacket(packet) {
        console.log(`VirtualCamera: Received packet type: ${packet.type}`);
        console.log(`VirtualCamera: Packet body: ${JSON.stringify(packet.body)}`);

        switch (packet.type) {
            case 'kdeconnect.virtualcamera':
                this._handleVideoPacket(packet);
                break;

            default:
                console.warn(`VirtualCamera: Unknown packet type: ${packet.type}`);
        }
    }

    /**
     * Handle incoming video packet
     *
     * @param {Core.Packet} packet - The incoming packet
     */
    async _handleVideoPacket(packet) {
        try {
            // Check if streaming started or stopped
            if (packet.body.hasOwnProperty('streaming')) {
                console.log(`VirtualCamera: Received streaming control: ${packet.body.streaming}`);
                if (packet.body.streaming) {
                    this._width = packet.body.width || 1280;
                    this._height = packet.body.height || 720;
                    this._fps = packet.body.fps || 15;
                    console.log(`VirtualCamera: Starting pipeline with ${this._width}x${this._height}@${this._fps}fps`);
                    this._startPipeline(this._width, this._height, this._fps);
                } else {
                    this._stopPipeline();
                }
                return;
            }

            // Handle incoming frame
            if (packet.body.frame) {
                console.log(`VirtualCamera: Frame received, hasPayload=${packet.hasPayload()}, payloadSize=${packet.payloadSize || 'N/A'}`);
                if (!this._streaming) {
                    console.warn('VirtualCamera: Received frame but not streaming - auto-starting pipeline');
                    this._startPipeline(this._width, this._height, this._fps);
                }
                if (packet.hasPayload()) {
                    await this._receiveFrame(packet);
                } else {
                    console.warn('VirtualCamera: Frame has no payload, skipping');
                }
            }
        } catch (e) {
            console.error('VirtualCamera: Error handling packet:', e);
        }
    }

    /**
     * Start GStreamer pipeline to v4l2loopback
     *
     * @param {number} width - Video width
     * @param {number} height - Video height
     * @param {number} fps - Frames per second
     */
    _startPipeline(width, height, fps) {
        if (!Gst) {
            console.error('VirtualCamera: GStreamer not available');
            this.device.showNotification({
                id: 'virtualcamera-error',
                title: 'Virtual Camera Error',
                body: 'GStreamer is not available. Please install gstreamer and gst-plugins-base.',
                icon: new Gio.ThemedIcon({ name: 'dialog-error-symbolic' }),
            });
            return;
        }

        // Load v4l2loopback module if not already loaded
        if (!this._loadV4l2LoopbackModule()) {
            console.error('VirtualCamera: Failed to load v4l2loopback module');
            this.device.showNotification({
                id: 'virtualcamera-error',
                title: 'Virtual Camera Error',
                body: 'Failed to load v4l2loopback module. You may need to sign it for Secure Boot.',
                icon: new Gio.ThemedIcon({ name: 'dialog-error-symbolic' }),
            });
            return;
        }

        // Use hardcoded v4l2loopback device path
        this._v4l2Device = '/dev/video10';

        if (this._pipeline !== null) {
            this._stopPipeline();
        }

        try {
            // Create pipeline: appsrc -> jpegdec -> videoscale -> videoconvert -> v4l2sink
            // Don't specify dimensions in appsrc caps - let jpegdec auto-detect from JPEG
            // Use videoscale to ensure output resolution matches v4l2loopback expectation
            const pipelineStr = `appsrc name=source is-live=true block=false do-timestamp=true format=time caps=image/jpeg,framerate=${fps}/1 ! jpegdec ! videoscale ! video/x-raw,width=${width},height=${height} ! videoconvert ! video/x-raw,format=YUY2 ! v4l2sink device=${this._v4l2Device} sync=false`;

            console.log(`VirtualCamera: Creating pipeline: ${pipelineStr}`);

            this._pipeline = Gst.parse_launch(pipelineStr);
            this._appsrc = this._pipeline.get_by_name('source');

            if (!this._appsrc) {
                throw new Error('Failed to get appsrc element');
            }

            // Set pipeline to playing
            const ret = this._pipeline.set_state(Gst.State.PLAYING);
            if (ret === Gst.StateChangeReturn.FAILURE) {
                throw new Error('Failed to start pipeline');
            }

            this._streaming = true;
            this.notify('streaming');

            console.log(`VirtualCamera: Started streaming to ${this._v4l2Device} (${width}x${height}@${fps}fps)`);

            this.device.showNotification({
                id: 'virtualcamera-started',
                title: 'Virtual Camera',
                body: `Camera streaming (${width}x${height}@${fps}fps)`,
                icon: new Gio.ThemedIcon({ name: 'camera-video-symbolic' }),
            });
        } catch (e) {
            console.error('VirtualCamera: Failed to start pipeline:', e);
            this._streaming = false;
            this.notify('streaming');

            this.device.showNotification({
                id: 'virtualcamera-error',
                title: 'Virtual Camera Error',
                body: `Failed to start: ${e.message}. Make sure v4l2loopback is loaded.`,
                icon: new Gio.ThemedIcon({ name: 'dialog-error-symbolic' }),
            });
        }
    }

    /**
     * Stop the GStreamer pipeline
     */
    _stopPipeline() {
        if (this._pipeline) {
            try {
                this._pipeline.set_state(Gst.State.NULL);
            } catch (e) {
                // Ignore
            }
            this._pipeline = null;
            this._appsrc = null;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._streaming) {
            this._streaming = false;
            this.notify('streaming');
            console.log('VirtualCamera: Stopped streaming');

            // Unload v4l2loopback module to remove virtual camera device
            this._unloadV4l2LoopbackModule();
        }
    }

    /**
     * Receive and process a video frame
     *
     * @param {Core.Packet} packet - Packet with frame payload
     */
    async _receiveFrame(packet) {
        if (!this._streaming) {
            console.log('VirtualCamera: _receiveFrame called but not streaming');
            return;
        }
        if (!this._appsrc) {
            console.log('VirtualCamera: _receiveFrame called but no appsrc');
            return;
        }

        try {
            this._cancellable = new Gio.Cancellable();

            // Download the frame payload
            const target = Gio.MemoryOutputStream.new_resizable();
            await this.device.channel.download(packet, target, this._cancellable);

            target.close(null);
            const data = target.steal_as_bytes();
            const size = data.get_size();
            console.log(`VirtualCamera: Downloaded frame, size=${size} bytes`);

            // Create GStreamer buffer from bytes
            const buffer = Gst.Buffer.new_wrapped(data.get_data());

            // Push buffer to appsrc
            const ret = this._appsrc.emit('push-buffer', buffer);
            if (ret !== Gst.FlowReturn.OK) {
                console.warn(`VirtualCamera: push-buffer returned ${ret}`);
            } else {
                console.log('VirtualCamera: Frame pushed to appsrc successfully');
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.error('VirtualCamera: Error receiving frame:', e);
            }
        }
    }

    /**
     * Request camera streaming from phone
     */
    startCamera() {
        const packet = new Core.Packet({
            type: 'kdeconnect.virtualcamera.request',
            body: {
                action: 'start',
                camera: 'back',
                resolution: '720p',
                fps: 15,
            },
        });

        this.device.sendPacket(packet);
    }

    /**
     * Load v4l2loopback kernel module using pkexec
     *
     * @returns {boolean} - True if load command was executed
     */
    _loadV4l2LoopbackModule() {
        try {
            const proc = new Gio.Subprocess({
                argv: ['pkexec', 'modprobe', 'v4l2loopback', 'devices=1', 'video_nr=10', 'card_label=GSConnect', 'exclusive_caps=1'],
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
            const success = proc.wait(null);
            if (success && proc.get_exit_status() === 0) {
                console.log('VirtualCamera: v4l2loopback module loaded successfully');
                return true;
            }
            console.error('VirtualCamera: Failed to load v4l2loopback module');
            return false;
        } catch (e) {
            console.error('VirtualCamera: Error loading v4l2loopback:', e);
            return false;
        }
    }

    /**
     * Unload v4l2loopback kernel module using pkexec
     *
     * @returns {boolean} - True if unload command was executed
     */
    _unloadV4l2LoopbackModule() {
        try {
            const proc = new Gio.Subprocess({
                argv: ['pkexec', 'rmmod', 'v4l2loopback'],
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
            const success = proc.wait(null);
            if (success && proc.get_exit_status() === 0) {
                console.log('VirtualCamera: v4l2loopback module unloaded successfully');
                return true;
            }
            console.log('VirtualCamera: v4l2loopback module was not loaded');
            return false;
        } catch (e) {
            console.error('VirtualCamera: Error unloading v4l2loopback:', e);
            return false;
        }
    }

    /**
     * Find an available v4l2loopback device
     *
     * @returns {string|null} - Device path or null if not found
     */
    _findV4l2LoopbackDevice() {
        // Check common v4l2loopback device paths
        for (let i = 0; i <= 63; i++) {
            const devicePath = `/dev/video${i}`;
            const sysPath = `/sys/devices/virtual/video4linux/video${i}`;

            try {
                const sysFile = Gio.File.new_for_path(sysPath);
                if (sysFile.query_exists(null)) {
                    // Check if it's a v4l2loopback device by checking the name
                    const namePath = `${sysPath}/name`;
                    const nameFile = Gio.File.new_for_path(namePath);
                    if (nameFile.query_exists(null)) {
                        const [, contents] = nameFile.load_contents(null);
                        const name = new TextDecoder().decode(contents).trim();
                        if (name.includes('v4l2loopback') || name.includes('GSConnect') || name.includes('Dummy') || name.includes('Virtual')) {
                            console.log(`VirtualCamera: Found v4l2loopback device: ${devicePath} (${name})`);
                            return devicePath;
                        }
                    }
                }
            } catch (e) {
                // Device doesn't exist or can't be read, continue
            }
        }
        return null;
    }

    /**
     * Request to stop camera streaming
     */
    stopCamera() {
        const packet = new Core.Packet({
            type: 'kdeconnect.virtualcamera.request',
            body: {
                action: 'stop',
            },
        });

        this.device.sendPacket(packet);
        this._stopPipeline();
    }

    destroy() {
        this._stopPipeline();
        super.destroy();
    }
});

export default VirtualCameraPlugin;
