// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {GObject} = imports.gi;
const MPRIS = imports.service.components.mpris;


const MockMediaPlayer = GObject.registerClass({
    GTypeName: 'MockMediaPlayer',
}, class MockMediaPlayer extends MPRIS.Player {

    _init(identity) {
        super._init();

        this._Identity = identity;
        this._Position = 0;
    }

    /**
     * Update the player with an object of properties and values.
     *
     * @param {Object} obj - A dictionary of properties
     */
    update(obj) {
        for (const [propertyName, propertyValue] of Object.entries(obj))
            this[`_${propertyName}`] = propertyValue;

        // An arbitrary property to notify
        this.notify('Volume');
    }

    Next() {
        if (!this.CanGoNext)
            throw new GObject.NotImplementedError();

        this.Metadata['xesam:title'] = 'Track 2';
        this.notify('Metadata');
    }

    Previous() {
        if (!this.CanGoPrevious)
            throw new GObject.NotImplementedError();

        this.Metadata['xesam:title'] = 'Track 1';
        this.notify('Metadata');
    }

    Pause() {
        if (!this.CanPause)
            throw new GObject.NotImplementedError();

        this._PlaybackStatus = 'Paused';
        this.notify('PlaybackStatus');
    }

    PlayPause() {
        if (!this.CanPlay && !this.CanPause)
            throw new GObject.NotImplementedError();

        if (this.PlaybackStatus === 'Playing')
            this._PlaybackStatus = 'Paused';
        else
            this._PlaybackStatus = 'Playing';

        this.notify('PlaybackStatus');
    }

    Stop() {
        this._PlaybackStatus = 'Stopped';
        this.notify('PlaybackStatus');
    }

    Play() {
        if (!this.CanPlay)
            throw new GObject.NotImplementedError();

        this._PlaybackStatus = 'Playing';
        this.notify('PlaybackStatus');
    }

    Seek(offset) {
        if (!this.CanSeek)
            throw new GObject.NotImplementedError();

        this._Position += offset;
        this.emit('Seeked', offset);
    }

    SetPosition(trackId, position) {
        const offset = this._Position - position;
        this.Seek(offset);
    }
});


var Component = GObject.registerClass({
    GTypeName: 'MockMPRISManager',
    Signals: {
        'player-added': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-removed': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-changed': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-seeked': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT64],
        },
    },
}, class MockMPRISManager extends GObject.Object {

    _init() {
        super._init();

        this._players = new Map();
        this._paused = new Map();
    }

    addPlayer(identity) {
        const player = new MockMediaPlayer(identity);

        player.connect('notify', () => this.emit('player-changed', player));
        player.connect('Seeked', this.emit.bind(this, 'player-seeked'));

        this._players.set(identity, player);
        this.emit('player-added', player);

        return player;
    }

    removePlayer(identity) {
        const player = this._players.get(identity);

        if (player === undefined)
            return;

        this._players.delete(identity);
        this.emit('player-removed', player);

        player.run_dispose();
    }

    getPlayer(identity) {
        for (const player of this._players.values()) {
            if (player.Identity === identity)
                return player;
        }

        return null;
    }

    hasPlayer(identity) {
        for (const player of this._players.values()) {
            if (player.Identity === identity)
                return true;
        }

        return false;
    }

    getIdentities() {
        const identities = [];

        for (const player of this._players.values()) {
            const identity = player.Identity;

            if (identity)
                identities.push(identity);
        }

        return identities;
    }

    pauseAll() {
    }

    unpauseAll() {
    }
});

