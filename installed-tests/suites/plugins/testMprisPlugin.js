// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


/**
 * Count the session bus connections that belong to this process.
 *
 * @returns {number} The number of connections
 */
function countBusConnections() {
    const pid = new Gio.Credentials().get_unix_pid();
    const call = (method, parameters = null) => {
        return Gio.DBus.session.call_sync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            method,
            parameters,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deepUnpack();
    };

    const [names] = call('ListNames');

    return names.filter(name => {
        if (!name.startsWith(':'))
            return false;

        // A connection can close between the two calls
        try {
            const [owner] = call('GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [name]));

            return owner === pid;
        } catch {
            return false;
        }
    }).length;
}

/**
 * Wait for this process to hold `expected` session bus connections. Give up
 * after two seconds, so that a leaked connection fails the expectation instead
 * of blocking the suite.
 *
 * @param {number} expected - The expected number of connections
 * @returns {Promise<number>} The number of connections last counted
 */
async function awaitBusConnections(expected) {
    let count = countBusConnections();

    for (let i = 0; i < 40 && count !== expected; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        count = countBusConnections();
    }

    return count;
}


describe('The mpris plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
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

        localPlugin = testRig.localDevice._plugins.get('mpris');
        remotePlugin = testRig.remoteDevice._plugins.get('mpris');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('requests and reports players when connected', async function () {
        await testRig.setConnected(true);

        await Promise.all([
            localPlugin.awaitPacket('kdeconnect.mpris.request'),
            remotePlugin.awaitPacket('kdeconnect.mpris.request'),
            localPlugin.awaitPacket('kdeconnect.mpris'),
            remotePlugin.awaitPacket('kdeconnect.mpris'),
        ]);
    });

    it('adds players', async function () {
        localPlugin._mpris.addPlayer('Music Player');
        expect(localPlugin._mpris.hasPlayer('Music Player')).toBeTrue();

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            playerList: ['Music Player'],
        });

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            canGoNext: false,
            canGoPrevious: false,
            canPause: false,
            canPlay: false,
            canSeek: false,
            isPlaying: false,
            length: 0,
            pos: 0,
            volume: 100,
        });

        expect(remotePlugin._players.has('Music Player')).toBeTrue();
    });

    it('sends and handles player changes', async function () {
        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        spyOn(remotePlayer, 'export');

        // Update while accounting for the position/length/volume conversion
        localPlayer.update({
            CanGoNext: true,
            CanGoPrevious: true,
            CanPause: true,
            CanPlay: true,
            CanSeek: true,
            PlaybackStatus: 'Playing',
            Position: 50000000,
            Volume: 0.5,
            Metadata: {
                'xesam:artist': ['Some Artist'],
                'xesam:album': 'Some Album',
                'xesam:title': 'Track 1',
                'mpris:length': 100000000,
            },
        });

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            canGoNext: true,
            canGoPrevious: true,
            canPause: true,
            canPlay: true,
            canSeek: true,
            isPlaying: true,
            length: 100000,
            pos: 50000,
            volume: 50,
            artist: 'Some Artist',
            album: 'Some Album',
            title: 'Track 1',
            nowPlaying: 'Some Artist - Track 1',
        });

        expect(remotePlayer.PlaybackStatus).toBe('Playing');
        expect(remotePlayer.export).toHaveBeenCalled();
    });

    it('sends and handles player seeking', async function () {
        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        // Update while accounting for the offset conversion
        localPlayer.Seek(100000);

        // NOTE: although we can handle full seeked signals, kdeconnect-android
        //       does not, and expects a position update instead
        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            pos: 50100,
            // Seek: 100,
        });

        expect(remotePlayer.Position).toBe(50100000);
    });

    it('sends and handles action commands', async function () {
        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        // Pause
        remotePlayer.Pause();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'Pause',
        });
        expect(localPlayer.PlaybackStatus).toBe('Paused');

        // Play
        remotePlayer.Play();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'Play',
        });
        expect(localPlayer.PlaybackStatus).toBe('Playing');

        // Play/Pause
        remotePlayer.PlayPause();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'PlayPause',
        });
        expect(localPlayer.PlaybackStatus).toBe('Paused');

        // Next
        remotePlayer.Next();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'Next',
        });
        expect(localPlayer.Metadata['xesam:title']).toBe('Track 2');

        // Previous
        remotePlayer.Previous();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'Previous',
        });
        expect(localPlayer.Metadata['xesam:title']).toBe('Track 1');

        // Stop
        remotePlayer.Stop();

        await localPlugin.awaitPacket('kdeconnect.mpris.request', {
            player: 'Music Player',
            action: 'Stop',
        });
        expect(localPlayer.PlaybackStatus).toBe('Stopped');
    });

    it('sends and receives album art', async function () {
        pending('FIXME');

        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        const localUrl = Utils.getDataUri('album.png');

        localPlayer.update({
            player: 'Music Player',
            Metadata: {
                'xesam:artist': ['Some Artist'],
                'xesam:album': 'Some Album',
                'xesam:title': 'Track 1',
                'mpris:length': 100000000,
                'mpris:artUrl': localUrl,
            },
        });

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            albumArtUrl: localUrl,
        });

        await new Promise((resolve, reject) => {
            remotePlayer.connect('notify::Metadata', () => {
                resolve();
            });
        });

        // Wait for the album art to transfer
        const remoteUrl = remotePlayer._getFile(localUrl).get_uri();
        const playerUrl = remotePlayer.Metadata['mpris:artUrl'].unpack();

        expect(playerUrl).toBe(remoteUrl);
    });

    it('unexports players when they can not be controlled', async function () {
        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        spyOn(remotePlayer, 'unexport');

        localPlayer.update({
            CanGoNext: false,
            CanGoPrevious: false,
            CanPause: false,
            CanPlay: false,
            CanSeek: false,
        });

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            canGoNext: false,
            canGoPrevious: false,
            canPause: false,
            canPlay: false,
            canSeek: false,
        });

        expect(remotePlayer.unexport).toHaveBeenCalled();
    });

    it('exports players when they can be controlled', async function () {
        const localPlayer = localPlugin._mpris.getPlayer('Music Player');
        const remotePlayer = remotePlugin._players.get('Music Player');

        spyOn(remotePlayer, 'export');

        localPlayer.update({
            CanGoNext: true,
            CanGoPrevious: true,
            CanPause: true,
            CanPlay: true,
            CanSeek: true,
        });

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            player: 'Music Player',
            canGoNext: true,
            canGoPrevious: true,
            canPause: true,
            canPlay: true,
            canSeek: true,
        });

        expect(remotePlayer.export).toHaveBeenCalled();
    });

    it('opens one bus connection for overlapping exports', async function () {
        const PlayerRemote = remotePlugin._players.get('Music Player').constructor;
        const player = new PlayerRemote(remotePlugin.device, 'Overlap Player');
        const connections = countBusConnections();

        await Promise.all([player.export(), player.export()]);
        expect(await awaitBusConnections(connections + 1)).toBe(connections + 1);

        player.destroy();
        expect(await awaitBusConnections(connections)).toBe(connections);
    });

    it('closes the bus connection of players destroyed while exporting', async function () {
        const PlayerRemote = remotePlugin._players.get('Music Player').constructor;
        const player = new PlayerRemote(remotePlugin.device, 'Short Player');
        const connections = countBusConnections();

        const exported = player.export();
        player.destroy();
        await exported;

        expect(await awaitBusConnections(connections)).toBe(connections);
    });

    it('removes players', async function () {
        localPlugin._mpris.removePlayer('Music Player');
        expect(localPlugin._mpris.hasPlayer('Music Player')).toBeFalse();

        await remotePlugin.awaitPacket('kdeconnect.mpris', {
            playerList: [],
        });
        expect(remotePlugin._players.has('Music Player')).toBeFalse();
    });

    it('disables its GActions when disconnected', async function () {
        await testRig.setConnected(false);

        expect(true).toBeTrue();
    });
});

