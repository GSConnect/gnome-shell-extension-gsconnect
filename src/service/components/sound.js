'use strict';

const Gio = imports.gi.Gio;


// GSound.Context singleton
try {
    var GSound = imports.gi.GSound;
    var _gsoundContext = new GSound.Context();
    _gsoundContext.init(null);

// Try falling back to libcanberra
} catch (e) {
    var _gsoundContext = undefined;

    if (!hasCommand('canberra-gtk-play')) {
        throw new Error();
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
    let result = false;

    if (_gsoundContext) {
        _gsoundContext.play_simple({ 'event.id' : name }, null);
        return true;
    } else if (hasCommand('canberra-gtk-play')) {
        let proc = new Gio.Subprocess({
            argv: ['canberra-gtk-play', '-i', name],
            flags: Gio.SubprocessFlags.NONE
        });
        proc.init(null);

        proc.wait_check_async(null, (proc, res) => {
            try {
                result = proc.wait_check_finish(res);
            } catch (e) {
            }
        });
    }

    return result;
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
    } else if (hasCommand('canberra-gtk-play')) {
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

