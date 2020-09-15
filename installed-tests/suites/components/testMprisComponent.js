'use strict';

const {Gio, GLib} = imports.gi;

const Utils = imports.fixtures.utils;
const {MockPlayer} = imports.fixtures.mpris;

const MPRIS = imports.service.components.mpris;


// Prevent auto-loading
MPRIS.Manager.prototype._loadPlayers = function () {};


describe('The MPRIS component', function () {
    let manager;
    let player;

    beforeAll(function () {
        manager = new MPRIS.Manager();
        player = new MockPlayer(GLib.uuid_string_random());
    });

    afterAll(function () {
        manager.destroy();
    });

    describe('emits a signal', function () {
        it('when players appear on the bus', function (done) {
            const id = manager.connect('player-added', (manager, proxy) => {
                manager.disconnect(id);

                expect(proxy.Identity).toBe(player.Identity);
                done();
            });

            player.export();
        });

        it('when players are changed', function (done) {
            const id = manager.connect('player-changed', (manager, proxy) => {
                manager.disconnect(id);

                expect(proxy.Volume).toBe(0.5);
                done();
            });

            player.Volume = 0.5;
        });

        it('when players are seeked', function (done) {
            const id = manager.connect('player-seeked', (manager, proxy, offset) => {
                manager.disconnect(id);

                expect(offset).toBe(1000);
                done();
            });

            player.emit('Seeked', 1000);
        });

        it('when players vanish from the bus', function (done) {
            const id = manager.connect('player-removed', (manager, proxy) => {
                manager.disconnect(id);

                expect(proxy.Identity).toBe(player.Identity);
                done();
            });

            player.unexport();
        });
    });

    describe('can track players', function () {
        beforeAll(function (done) {
            const id = manager.connect('player-added', (manager, proxy) => {
                manager.disconnect(id);
                done();
            });

            // Prep for pause/unpause tests
            player._CanPause = true;
            player._CanPlay = true;
            player._PlaybackStatus = 'Playing';

            player.export();
        });

        afterAll(function (done) {
            const id = manager.connect('player-removed', (manager, proxy) => {
                manager.disconnect(id);
                done();
            });

            player.unexport();
        });

        it('and check for them', function () {
            expect(manager.hasPlayer(player.Identity)).toBeTrue();
        });

        it('and retrieve them', function () {
            let proxy = manager.getPlayer(player.Identity);
            expect(proxy.Identity).toBe(player.Identity);
        });

        it('and list their identities', function () {
            expect(manager.getIdentities()).toContain(player.Identity);
        });

        it('and pause them as a group', function (done) {
            const id = player.connect('notify::PlaybackStatus', (player) => {
                player.disconnect(id);

                expect(player.PlaybackStatus).toBe('Paused');
                done();
            });

            manager.pauseAll();
        });

        it('and unpause them as a group', function (done) {
            pending('fix property propagation');

            const id = player.connect('notify::PlaybackStatus', (player) => {
                player.disconnect(id);

                expect(player.PlaybackStatus).toBe('Playing');
                done();
            });

            manager.unpauseAll();
        });
    });
});

