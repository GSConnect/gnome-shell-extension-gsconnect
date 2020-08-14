'use strict';

const Tweener = imports.tweener.tweener;

const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;


// Add gnome-shell's typelib dir to the search path
let typelibDir = GLib.build_filenamev([Config.GNOME_SHELL_LIBDIR, 'gnome-shell']);
GIRepository.Repository.prepend_search_path(typelibDir);
GIRepository.Repository.prepend_library_path(typelibDir);

const Gvc = imports.gi.Gvc;


/**
 * Extend Gvc.MixerStream with a property for returning a user-visible name
 */
Object.defineProperty(Gvc.MixerStream.prototype, 'display_name', {
    get: function () {
        try {
            if (!this.get_ports().length)
                return this.description;

            return `${this.get_port().human_port} (${this.description})`;
        } catch (e) {
            return this.description;
        }
    },
});


/**
 * A convenience wrapper for Gvc.MixerStream
 */
class Stream {
    constructor(mixer, stream) {
        this._mixer = mixer;
        this._stream = stream;

        this._max = mixer.get_vol_max_norm();
    }

    get muted() {
        return this._stream.is_muted;
    }

    set muted(bool) {
        this._stream.change_is_muted(bool);
    }

    // Volume is a double in the range 0-1
    get volume() {
        return Math.floor(100 * this._stream.volume / this._max) / 100;
    }

    set volume(num) {
        this._stream.volume = Math.floor(num * this._max);
        this._stream.push_volume();
    }

    /**
     * Gradually raise or lower the stream volume to @value
     *
     * @param {number} value - A number in the range 0-1
     * @param {number} [duration] - Duration to fade in seconds
     */
    fade(value, duration = 1) {
        Tweener.removeTweens(this);

        if (this._stream.volume > value) {
            this._mixer.fading = true;

            Tweener.addTween(this, {
                volume: value,
                time: duration,
                transition: 'easeOutCubic',
                onComplete: () => {
                    this._mixer.fading = false;
                },
            });
        } else if (this._stream.volume < value) {
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


/**
 * A subclass of Gvc.MixerControl with convenience functions for controlling the
 * default input/output volumes.
 *
 * The Mixer class uses GNOME Shell's Gvc library to control the system volume
 * and offers a few convenience functions.
 */
const Mixer = GObject.registerClass({
    GTypeName: 'GSConnectAudioMixer',
}, class Mixer extends Gvc.MixerControl {
    _init(params) {
        super._init({name: 'GSConnect'});

        this._previousVolume = undefined;
        this._volumeMuted = false;
        this._microphoneMuted = false;

        this.open();
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
            this.emit('stream-changed', this._output._stream.id);
    }

    get input() {
        if (this._input === undefined)
            this.vfunc_default_source_changed();

        return this._input;
    }

    get output() {
        if (this._output === undefined)
            this.vfunc_default_sink_changed();

        return this._output;
    }

    vfunc_default_sink_changed(id) {
        try {
            let sink = this.get_default_sink();
            this._output = (sink) ? new Stream(this, sink) : null;
        } catch (e) {
            logError(e);
        }
    }

    vfunc_default_source_changed(id) {
        try {
            let source = this.get_default_source();
            this._input = (source) ? new Stream(this, source) : null;
        } catch (e) {
            logError(e);
        }
    }

    vfunc_state_changed(new_state) {
        try {
            if (new_state === Gvc.MixerControlState.READY) {
                this.vfunc_default_sink_changed(null);
                this.vfunc_default_source_changed(null);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Store the current output volume then lower it to %15
     *
     * @param {number} duration - Duration in seconds to fade
     */
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

    /**
     * Mute the output volume (speakers)
     */
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

    /**
     * Mute the input volume (microphone)
     */
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

    /**
     * Restore all mixer levels to their previous state
     */
    restore() {
        try {
            // If we muted the microphone, unmute it before restoring the volume
            if (this._microphoneMuted) {
                this.input.muted = false;
                this._microphoneMuted = false;
            }

            // If we muted the volume, unmute it before restoring the volume
            if (this._volumeMuted) {
                this.output.muted = false;
                this._volumeMuted = false;
            }

            // If a previous volume is defined, raise it back up to that level
            if (this._previousVolume !== undefined) {
                this.output.fade(this._previousVolume);
                this._previousVolume = undefined;
            }
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        this.close();
    }
});


/**
 * The service class for this component
 */
var Component = Mixer;

