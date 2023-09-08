// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Tweener = imports.tweener.tweener;

import * as GLib from "gi://GLib";
import * as GObject from "gi://GObject";


class MockStream {
    constructor(mixer, id) {
        this._mixer = mixer;
        this._id = id;

        this._max = this._mixer.get_vol_max_norm();
    }

    get display_name() {
        return `Stream ${this.id}`;
    }

    get id() {
        if (this._id === undefined)
            this._id = Math.floor(Math.random() * 100);

        return this._id;
    }

    get is_muted() {
        return this.muted;
    }

    get muted() {
        if (this._muted === undefined)
            this._muted = false;

        return this._muted;
    }

    set muted(muted) {
        if (this.muted === muted)
            return;

        this._muted = muted;
    }

    get name() {
        return `${this.id}`;
    }

    // Volume is a double in the range 0-1
    get volume() {
        if (this._volume === undefined)
            this._volume = 1.0;

        return this._volume;
    }

    set volume(volume) {
        if (this.volume === volume)
            return;

        this._volume = volume;
    }

    change_is_muted(muted) {
        this.muted = muted;
    }

    fade(value, duration = 1) {
        Tweener.removeTweens(this);

        if (this.volume > value) {
            this._mixer.fading = true;

            Tweener.addTween(this, {
                volume: value,
                time: duration,
                transition: 'easeOutCubic',
                onComplete: () => {
                    this._mixer.fading = false;
                },
            });
        } else if (this.volume < value) {
            this._mixer.fading = true;

            Tweener.addTween(this, {
                volume: value,
                time: duration,
                transition: 'easeInCubic',
                onComplete: () => {
                    this._mixer.fading = false;
                },
            });
        }
    }
}


var Component = GObject.registerClass({
    GTypeName: 'GSConnectMockMixer',
    Signals: {
        'output-added': {
            param_types: [GObject.TYPE_UINT],
        },
        'output-removed': {
            param_types: [GObject.TYPE_UINT],
        },
        'stream-changed': {
            param_types: [GObject.TYPE_UINT],
        },
    },
}, class MockMixer extends GObject.Object {
    _init() {
        super._init();

        this._sinks = new Map([
            [0, new MockStream(this, 0)],
        ]);

        this._sources = new Map([
            [0, new MockStream(this, 0)],
        ]);

        this._previousVolume = undefined;
        this._volumeMuted = false;
        this._microphoneMuted = false;
    }

    get fading() {
        if (this._fading === undefined)
            this._fading = false;

        return this._fading;
    }

    set fading(bool) {
        if (this.fading === bool)
            return;

        this._fading = bool;

        if (this.fading)
            this.emit('stream-changed', this.output.id);
    }

    get input() {
        if (this._input === undefined)
            this._input = this._sources.get(0);

        return this._input;
    }

    get output() {
        if (this._output === undefined)
            this._output = this._sinks.get(0);

        return this._output;
    }

    get_sinks() {
        return Array.from(this._sinks.values());
    }

    get_vol_max_norm() {
        return 65536;
    }

    lookup_sink(id) {
        const sink = this._sinks.get(id);

        return sink || null;
    }

    lowerVolume(duration = 1) {
        try {
            if (this.output.volume > 0.15) {
                this._previousVolume = Number(this.output.volume);
                this.output.fade(0.15, duration);
            }
        } catch (e) {
            logError(e);
        }
    }

    muteVolume() {
        try {
            if (this.output.muted)
                return;

            this.output.muted = true;
            this._volumeMuted = true;
        } catch (e) {
            logError(e);
        }
    }

    muteMicrophone() {
        try {
            if (this.input.muted)
                return;

            this.input.muted = true;
            this._microphoneMuted = true;
        } catch (e) {
            logError(e);
        }
    }

    restore() {
        try {
            if (this._microphoneMuted) {
                this.input.muted = false;
                this._microphoneMuted = false;
            }

            if (this._volumeMuted) {
                this.output.muted = false;
                this._volumeMuted = false;
            }

            if (this._previousVolume !== undefined) {
                this.output.fade(this._previousVolume);
                this._previousVolume = undefined;
            }
        } catch (e) {
            logError(e);
        }
    }
});

