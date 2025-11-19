// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import 'gi://Gdk?version=3.0';
import 'gi://Gtk?version=3.0';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


// Ensure the environment is prepared for testing
import Config from '../config.js';

if (GLib.getenv('GSCONNECT_TEST')) {
    Config.PACKAGE_DATADIR = GLib.getenv('GJS_PATH');
    Config.GSETTINGS_SCHEMA_DIR = GLib.getenv('GSETTINGS_SCHEMA_DIR');
} else {
    GLib.setenv('G_DEBUG', 'fatal-warnings,fatal-criticals', true);
    GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
    GLib.setenv('NO_AT_BRIDGE', '1', true);
}


await import(`file://${Config.PACKAGE_DATADIR}/service/init.js`);
const {default: Device} = await import(`file://${Config.PACKAGE_DATADIR}/service/device.js`);
const {default: Plugin} = await import(`file://${Config.PACKAGE_DATADIR}/service/plugin.js`);

const {ChannelService} = await import('./backend.js');


// Force testing under GNOME
globalThis.HAVE_GNOME = true;


/*
 * File Helpers
 */


/**
 * Find the path to the datadir via the import path.
 *
 * @returns {string} The absolute datadir path
 */
function get_datadir() {
    const thisFile = Gio.File.new_for_uri(import.meta.url);

    return thisFile.get_parent().get_parent().get_child('data').get_path();
}

const DATA_PATH = get_datadir();


/**
 * Convert a filename into a path within the datadir
 *
 * @param {string} filename - A filename
 * @returns {string} An absolute path
 */
export function getDataPath(filename) {
    return GLib.build_filenamev([DATA_PATH, filename]);
}


/**
 * Convert a filename into a URI within the datadir
 *
 * @param {string} filename - A filename
 * @returns {string} An absolute-path URI
 */
export function getDataUri(filename) {
    return `file://${getDataPath(filename)}`;
}


/**
 * Create a Gio.File object for a filename within the datadir
 *
 * @param {string} filename - A filename
 * @returns {Gio.File} A File object representing the named file
 */
export function getDataFile(filename) {
    return Gio.File.new_for_path(getDataPath(filename));
}


/**
 * Read the contents of a file
 *
 * @param {string} filename - The file to load
 * @returns {string} The file's contents as a UTF-8 string
 */
export function loadDataContents(filename) {
    const path = getDataPath(filename);
    const bytes = GLib.file_get_contents(path)[1];

    return new TextDecoder().decode(bytes);
}


/*
 * Async Helpers
 */
Promise.idle = function (priority = GLib.PRIORITY_DEFAULT_IDLE) {
    return new Promise(resolve => {
        GLib.idle_add(priority, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
};


/*
 * Identity Helpers
 */

/**
 * Get a pseudo-random device type
 *
 * @returns {string} A GSConnect device type
 */
function getDeviceType() {
    const types = [
        'desktop',
        'laptop',
        'phone',
        'tablet',
        'tv',
    ];
    return types[Math.floor(Math.random() * types.length)];
}


/**
 * Generate a pseudo-random device identity.
 *
 * @param {object} params - Override parameters
 * @returns {object} A pseudo-random identity packet
 */
export function generateIdentity(params = {}) {
    const identity = {
        'id': Date.now(),
        'type': 'kdeconnect.identity',
        'body': {
            'deviceId': Device.generateId(),
            'deviceName': 'Test Device',
            'deviceType': getDeviceType(),
            'protocolVersion': 8,
            'incomingCapabilities': [],
            'outgoingCapabilities': [],
        },
    };

    for (const [key, value] of Object.entries(params)) {
        if (key === 'body')
            Object.assign(identity.body, value);
        else
            identity[key] = value;
    }

    return identity;
}


/**
 * Check if {@link subset} is a subset of {@link obj}.
 *
 * @param {object} obj - The haystack to compare with
 * @param {object} subset - The needle to search for
 * @returns {boolean} %true if the object is a subset
 */
function isSubset(obj, subset) {
    for (const [key, val] of Object.entries(subset)) {
        if (!obj.hasOwnProperty(key))
            return false;

        // We were only checking for the key itself
        if (typeof val === 'undefined')
            continue;

        if (Array.isArray(val)) {
            // If passed an empty array, we're expecting it to be empty
            if (val.length === 0 && obj[key].length !== 0)
                return false;

            // Otherwise we're looking for a subset of the array
            if (!val.every(n => obj[key].includes(n)))
                return false;

            continue;
        }

        // This is JSON and KDE Connect has no %null use; an object is an object
        if (typeof val === 'object') {
            if (!isSubset(obj[key], val))
                return false;

            continue;
        }

        if (obj[key] !== val)
            return false;
    }

    return true;
}


/**
 * Wait for the `handlePacket` method of a device or plugin to be passed a
 * packet to handle. Note, the object must have an active jasmine spy.
 *
 * @param {string} type - A KDE Connect packet type
 * @param {object} [body] - Packet body properties
 */
async function _awaitPacket(type, body = null) {
    while (true) {
        for (const [packet] of this.handlePacket.calls.allArgs()) {
            if (packet.type !== type)
                continue;

            if (body === null)
                return;

            if (isSubset(packet.body, body))
                return;
        }

        await Promise.idle(GLib.PRIORITY_DEFAULT);
    }
}

Device.prototype.awaitPacket = _awaitPacket;
Plugin.prototype.awaitPacket = _awaitPacket;


/**
 * Create temporary directories used by GSConnect.
 *
 * @returns {string} The root temporary directory
 */
function isolateDirectories() {
    const tmpdir = GLib.Dir.make_tmp('gsconnect.XXXXXX');

    Config.CACHEDIR = GLib.build_filenamev([tmpdir, 'cache']);
    Config.CONFIGDIR = GLib.build_filenamev([tmpdir, 'config']);
    Config.RUNTIMEDIR = GLib.build_filenamev([tmpdir, 'runtime']);

    for (const path of [Config.CACHEDIR, Config.CONFIGDIR, Config.RUNTIMEDIR])
        GLib.mkdir_with_parents(path, 0o755);

    return tmpdir;
}


/**
 * Patch in the mock components for plugin tests.
 */
export async function mockComponents() {
    const {functionOverrides} = await import(`file://${Config.PACKAGE_DATADIR}/service/components/index.js`);
    const MockComponents = await import('./components/index.js');

    functionOverrides.acquire = function (name) {
        return new MockComponents[name].default();
    };

    functionOverrides.release = function (name) {
        return null;
    };
}

/**
 * Recursively remove a directory.
 *
 * @param {Gio.File|string} file - The file or path to delete
 */
function removeDirectory(file) {
    try {
        if (typeof file === 'string')
            file = Gio.File.new_for_path(file);

        try {
            const iter = file.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

            let info;

            while ((info = iter.next_file(null)))
                removeDirectory(iter.get_child(info));

            iter.close(null);
        } catch {
        }

        file.delete(null);
    } catch {
    }
}


/**
 * A test rig with two active GSconnectChannelService instances.
 */
export class TestRig {
    /**
     * Create a new test rig.
     *
     * @param {boolean} [dirs] - Whether to isolate user directories
     */
    constructor(dirs = true) {
        this.localService = new ChannelService({id: 'local-service'});
        this.localDevice = null;
        this.localChannel = null;

        this.remoteService = new ChannelService({id: 'remote-service'});
        this.remoteDevice = null;
        this.remoteChannel = null;

        if (dirs)
            this._tmpdir = isolateDirectories();
    }

    /**
     * Prepare two devices and channels with appropriate capabilities.
     *
     * Connect the devices with `setConnected()`, pair them with `setPaired()`
     * and load their plugins with `loadPlugins()`.
     *
     * @param {object} [overrides] - Capability overrides
     * @param {object} overrides.localDevice - Local device overrides
     * @param {object} overrides.remoteDevice - Remote device overrides
     * @returns {Promise} A promise for the operation
     */
    prepare(overrides = {}) {
        return new Promise((resolve, reject) => {
            const localId = this.localService.connect('channel', (service, channel) => {
                service.disconnect(localId);

                if (overrides.localDevice)
                    Object.assign(channel.identity.body, overrides.localDevice);

                this.localChannel = channel;
                this.localDevice = new Device(channel.identity);

                if (this.localDevice && this.remoteDevice)
                    resolve();

                return true;
            });

            const remoteId = this.remoteService.connect('channel', (service, channel) => {
                service.disconnect(remoteId);

                if (overrides.remoteDevice)
                    Object.assign(channel.identity.body, overrides.remoteDevice);

                this.remoteChannel = channel;
                this.remoteDevice = new Device(channel.identity);

                if (this.localDevice && this.remoteDevice)
                    resolve();

                return true;
            });

            this.localService.start();
            this.remoteService.start();

            this.localService.broadcast(`127.0.0.1:${this.remoteService.port}`);
        });
    }

    /**
     * Set both devices as connected by applying the negotiated channels.
     *
     * @param {boolean} connected - %true to connect, %false to disconnect
     */
    async setConnected(connected) {
        if (connected) {
            this.localDevice.setChannel(this.localChannel);
            this.remoteDevice.setChannel(this.remoteChannel);
        } else {
            this.localDevice.setChannel(null);
            this.remoteDevice.setChannel(null);
        }

        await Promise.idle();
    }

    /**
     * Set both devices as paired by calling the internal setters.
     *
     * @param {boolean} paired - %true to pair, %false to unpair
     */
    setPaired(paired) {
        this.localDevice._setPaired(paired);
        this.remoteDevice._setPaired(paired);
    }

    async loadPlugins() {
        await this.localDevice._loadPlugins();
        await this.remoteDevice._loadPlugins();
    }

    destroy() {
        // Local Device
        if (this.localDevice)
            this.localDevice.destroy();

        if (this.localChannel)
            this.localChannel.close();

        // Remote Device
        if (this.remoteDevice)
            this.remoteDevice.destroy();

        if (this.remoteChannel)
            this.remoteChannel.close();

        // Channel Services
        if (this.localService)
            this.localService.destroy();

        if (this.remoteService)
            this.remoteService.destroy();

        // Cleanup temporary files
        if (this._tmpdir)
            removeDirectory(this._tmpdir);
    }
}
