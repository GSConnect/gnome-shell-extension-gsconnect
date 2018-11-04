'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

var GSound;
var _gsoundContext;
var _BACKEND = false;


/**
 * Return the backend to be used for playing sound effects
 *
 * @return {string|boolean} - 'gsound', 'libcanberra' or %false
 */
function get_backend() {
    if (_BACKEND) {
        return _BACKEND;
    }

    // GSound.Context singleton
    try {
        GSound = imports.gi.GSound;
        _gsoundContext = new GSound.Context();
        _gsoundContext.init(null);
        _BACKEND = 'gsound';

    // Try falling back to libcanberra
    } catch (e) {
        if (GLib.find_program_in_path('canberra-gtk-play') !== null) {
            _BACKEND = 'libcanberra';
        }
    }

    return _BACKEND;
}


/**
 * Play a themed sound on a loop. Works like playThemeSound(), but will repeat
 * until @cancellable is triggered.
 *
 * @param {String} name - The name of a themed sound, from the current theme
 * @param {Gio.Cancellable} - A cancellable object used to stop playback
 * @return {Boolean} - %false if playback unavailable
 */
function loop_theme_sound(name, cancellable) {
    let error, proc;

    switch (get_backend()) {
        case 'gsound':
            _gsoundContext.play_full(
                {'event.id': name},
                cancellable,
                (source, res) => {
                    try {
                        source.play_full_finish(res);
                        loop_theme_sound(name, cancellable);
                    } catch (e) {
                    }
                }
            );
            return true;

        case 'libcanberra':
            proc = new Gio.Subprocess({
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
            return true;

        default:
            if (cancellable) {
                cancellable.cancel();
            }

            error = new Error();
            error.name = 'DependencyError';
            Gio.Application.get_default().notify_error(error);

            return false;
    }
}

window.loop_theme_sound = loop_theme_sound;

