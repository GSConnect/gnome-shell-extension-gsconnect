'use strict';

const Tweener = imports.tweener.tweener;

const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


// GSound.Context singleton
try {
    var GSound = imports.gi.GSound;
    var _gsoundContext = new GSound.Context();
    _gsoundContext.init(null);
} catch (e) {
    var _gsoundContext = undefined;

    // Try falling back to libcanberra
    if (!gsconnect.hasCommand('canberra-gtk-play')) {
        throw new Error('sound-error');
    }
}


/**
 * Play a themed sound
 *
 * @param {String} name - The name of a themed sound, from the current theme
 * @return {Boolean} - %true on success or %false if playback unavailable
 *
 * See also https://freedesktop.org/wiki/Specifications/sound-theme-spec/
 */
function play_theme_sound(name) {
    if (_gsoundContext) {
        _gsoundContext.play_simple({ 'event.id' : name }, null);
        return true;
    } else if (gsconnect.hasCommand('canberra-gtk-play')) {
        GLib.spawn_command_line_async('canberra-gtk-play -i ' + name);
        return true;
    }

    return false;
}

window.play_theme_sound = play_theme_sound;


/**
 * Play a themed sound on a loop. Works like playThemeSound(), but will repeat
 * until @cancellable is triggered.
 *
 * @param {String} name - The name of a themed sound, from the current theme
 * @param {Gio.Cancellable} - A cancellable object used to stop playback
 * @return {Boolean} - %false if playback unavailable
 */
function loop_theme_sound(name, cancellable) {
    if (_gsoundContext) {
        _gsoundContext.play_full(
            { 'event.id' : name },
            cancellable,
            (source, res) => {
                try {
                    source.play_full_finish(res);
                    loop_theme_sound(name, cancellable);
                } catch (e) {
                }
            }
        );
    } else if (gsconnect.hasCommand('canberra-gtk-play')) {
        let proc = new Gio.Subprocess({
            argv: ['canberra-gtk-play', '-i', name],
            flags: Gio.SubprocessFlags.NONE
        });
        proc.init(null);

        proc.wait_check_async(cancellable, (proc, res) => {
            try {
                proc.wait_check_finish(res);
                loop_theme_sound(name, cancellable);
            } catch (e) {
            }
        });
    } else {
        return false;
    }
}

window.loop_theme_sound = loop_theme_sound;


try {
    // Add gnome-shell's typelib dir to the search path
    let typelibDir = GLib.build_filenamev([gsconnect.libdir, 'gnome-shell']);
    GIRepository.Repository.prepend_search_path(typelibDir);
    GIRepository.Repository.prepend_library_path(typelibDir);

    var Gvc = imports.gi.Gvc;
} catch (e) {
    throw new Error('volume-error');
}


/**
 * A convenience wrapper for Gvc.MixerStream
 */
class Stream {
    constructor(mixer, stream) {
        this._max = mixer.get_vol_max_norm();
        this._stream = stream;
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
     * @param {Number} value - A number in the range 0-1
     */
    fade(value) {
        Tweener.removeTweens(this);

        if (this._stream.volume > value) {
            Tweener.addTween(this, {
                volume: value,
                time: 1,
                transition: 'easeOutCubic'
            });
        } else if (this._stream.volume < value) {
            Tweener.addTween(this, {
                volume: value,
                time: 1,
                transition: 'easeInCubic'
            });
        }
    }
}


/**
 * A subclass of Gvc.MixerControl with convenience functions for controlling the
 * default input/output volumes.
 *
 * The Mixer class uses Gnome Shell's Gvc library to control the system volume
 * and offers a few convenience functions.
 */
var Mixer = GObject.registerClass({
    GTypeName: 'GSConnectAudioMixer'
}, class Mixer extends Gvc.MixerControl {
    _init(params) {
        super._init({ name: 'GSConnect' });

        this.open();

        this._previousVolume = undefined;
        this._volumeMuted = false;
        this._microphoneMuted = false;
    }

    get input() {
        if (this._input === undefined) {
            this.vfunc_default_source_changed();
        }

        return this._input;
    }

    get output() {
        if (this._output === undefined) {
            this.vfunc_default_sink_changed();
        }

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
     */
    lowerVolume() {
        try {
            if (this.output.volume > 0.15) {
                this._previousVolume = Number(this.output.volume);
                this.output.fade(0.15);
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
            if (!this.output.muted) {
                this.output.muted = true;
                this._volumeMuted = true;
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Mute the input volume (microphone)
     */
    muteMicrophone() {
        try {
            if (!this.input.muted) {
                this.input.muted = true;
                this._microphoneMuted = true;
            }
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
});

