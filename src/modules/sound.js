'use strict';

const Tweener = imports.tweener.tweener;

const Gio = imports.gi.Gio;
const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Add gnome-shell's typelib dir to the search path
let typelibDir = GLib.build_filenamev([gsconnect.libdir, 'gnome-shell']);
GIRepository.Repository.prepend_search_path(typelibDir);
GIRepository.Repository.prepend_library_path(typelibDir);


// Gvc.MixerControl singleton
try {
    var Gvc = imports.gi.Gvc;
    var _mixerControl = new Gvc.MixerControl({ name: 'GSConnect' });
    _mixerControl.open();
} catch (e) {
    logWarning(e, 'Initializing Gvc');
    var _mixerControl = undefined;
}

// GSound.Context singleton
try {
    var GSound = imports.gi.GSound;
    var _gsoundContext = new GSound.Context();
    _gsoundContext.init(null);
} catch (e) {
    logWarning(e, 'Initializing GSound');
    var _gsoundContext = undefined;
}


/**
 * Play a themed sound
 *
 * @param {String} name - The name of a themed sound, from the current theme
 * @return {Boolean} - %true on success or %false if playback unavailable
 *
 * See also https://freedesktop.org/wiki/Specifications/sound-theme-spec/
 */
function playThemeSound(name) {
    if (_gsoundContext) {
        _gsoundContext.play_simple({ 'event.id' : name }, null);
        return true;
    } else if (gsconnect.hasCommand('canberra-gtk-play')) {
        GLib.spawn_command_line_async('canberra-gtk-play -i ' + name);
        return true;
    }

    return false;
}


/**
 * Play a themed sound on a loop. Works like playThemeSound(), but will repeat
 * until @cancellable is triggered.
 *
 * @param {String} name - The name of a themed sound, from the current theme
 * @param {Gio.Cancellable} - A cancellable object used to stop playback
 * @return {Boolean} - %false if playback unavailable
 */
function loopThemeSound(name, cancellable) {
    if (_gsoundContext) {
        _gsoundContext.play_full(
            { 'event.id' : name },
            cancellable,
            (source, res) => {
                try {
                    source.play_full_finish(res);
                    loopThemeSound(name, cancellable);
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
                loopThemeSound(name, cancellable);
            } catch (e) {
                logError(e);
            }
        });
    }

    return false;
}


var Stream = GObject.registerClass({
    GTypeName: 'GSConnectSoundStream',
    Properties: {
        'muted': GObject.ParamSpec.boolean(
            'muted',
            'StreamMuted',
            'Stream Muted',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'volume': GObject.ParamSpec.int(
            'volume',
            'StreamVolume',
            'Stream Volume',
            GObject.ParamFlags.READWRITE,
            0
        )
    }
}, class Stream extends GObject.Object {

    _init(stream) {
        super._init();

        this._max = _mixerControl.get_vol_max_norm()
        this._stream = stream;
    }

    get muted () {
        return this._stream.is_muted;
    }

    set muted (bool) {
        this._stream.change_is_muted(bool);
        this.notify('muted');
    }

    get volume () {
        return Math.round(100 * this._stream.volume / this._max) / 100;
    }

    set volume (num) {
        this._stream.volume = num * this._max;
        this._stream.push_volume();
        this.notify('volume');
    }

    lower(value) {
        Tweener.removeTweens(this);
        Tweener.addTween(this, {
            volume: value,
            time: 1,
            transition: 'easeOutCubic',
            onComplete: () => Tweener.removeTweens(this)
        });
    }

    raise(value) {
        Tweener.removeTweens(this);
        Tweener.addTween(this, {
            volume: value,
            time: 1,
            transition: 'easeInCubic',
            onComplete: () => Tweener.removeTweens(this)
        });
    }
});


/**
 * A simple class for abstracting volume control.
 *
 * The Mixer class uses Gnome Shell's Gvc library to control the system volume
 * and offers a few convenience functions.
 */
var Mixer = class Mixer {

    constructor() {
        this._control = _mixerControl;

        if (this._control) {
            this._defaultSinkChangedId = this._control.connect(
                'default-sink-changed',
                this._onDefaultSinkChanged.bind(this)
            );

            this._defaultSourceChangedId = this._control.connect(
                'default-source-changed',
                this._onDefaultSourceChanged.bind(this)
            );

            this._stateChangedId = this._control.connect(
                'state-changed',
                this._onStateChanged.bind(this)
            );

            this._onStateChanged();
        }

        this._previousVolume = undefined;
        this._volumeMuted = false;
        this._microphoneMuted = false;
    }

    get input() {
        return this._input;
    }

    get output() {
        return this._output;
    }

    _onDefaultSinkChanged() {
        this._output = new Stream(this._control.get_default_sink());
    }

    _onDefaultSourceChanged() {
        this._input = new Stream(this._control.get_default_source());
    }

    _onStateChanged() {
        if (this._control.get_state() == Gvc.MixerControlState.READY) {
            this._onDefaultSinkChanged();
            this._onDefaultSourceChanged();
        }
    }

    /**
     * Lower or raise the output volume to a specified level.
     *
     * @param {Number} level - Level to set the output volume to
     */
    setVolume(level) {
        if (!this._control) { return; }

        if (this.output.volume > level) {
            this.output.lower(level);
        } else if (this.output.volume < level) {
            this.output.raise(level);
        }
    }

    /**
     * Store the current output volume then lower it to %15
     */
    lowerVolume() {
        if (!this._control) { return; }

        if (this.output.volume > 0.15) {
            this._previousVolume = Number(this.output.volume);
            this.output.lower(0.15);
        }
    }

    /**
     * Mute the output volume (speakers)
     */
    muteVolume() {
        if (!this._control) { return; }

        if (!this.output.muted) {
            this.output.muted = true;
            this._volumeMuted = true;
        }
    }

    /**
     * Mute the input volume (microphone)
     */
    muteMicrophone() {
        if (!this._control) { return; }

        if (!this.input.muted) {
            this.input.muted = true;
            this._microphoneMuted = true;
        }
    }

    /**
     * Restore all mixer levels to their previous state
     */
    restore() {
        if (!this._control) { return; }

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
            this.output.raise(this._previousVolume);
            this._previousVolume = undefined;
        }
    }

    destroy() {
        if (this._control) {
            this._control.disconnect(this._defaultSinkChangedId);
            this._control.disconnect(this._defaultSourceChangedId);
            this._control.disconnect(this._stateChangedId);
        }
    }
}

