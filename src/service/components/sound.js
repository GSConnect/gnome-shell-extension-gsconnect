'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;


/*
 * Used to ensure 'audible-bell' is enabled for fallback
 */
const WM_SETTINGS = new Gio.Settings({
    schema_id: 'org.gnome.desktop.wm.preferences',
    path: '/org/gnome/desktop/wm/preferences/',
});


var Player = class Player {

    constructor() {
        this._playing = new Set();
    }

    get backend() {
        if (this._backend === undefined) {
            // Prefer GSound
            try {
                this._gsound = new imports.gi.GSound.Context();
                this._gsound.init(null);
                this._backend = 'gsound';

            // Try falling back to libcanberra, otherwise just re-run the test
            // in case one or the other is installed later
            } catch (e) {
                if (GLib.find_program_in_path('canberra-gtk-play') !== null) {
                    this._canberra = new Gio.SubprocessLauncher({
                        flags: Gio.SubprocessFlags.NONE,
                    });
                    this._backend = 'libcanberra';
                } else {
                    return null;
                }
            }
        }

        return this._backend;
    }

    _canberraPlaySound(name, cancellable) {
        return new Promise((resolve, reject) => {
            let proc = this._canberra.spawnv(['canberra-gtk-play', '-i', name]);

            proc.wait_check_async(cancellable, (proc, res) => {
                try {
                    resolve(proc.wait_check_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _canberraLoopSound(name, cancellable) {
        while (!cancellable.is_cancelled())
            await this._canberraPlaySound(name, cancellable);
    }

    _gsoundPlaySound(name, cancellable) {
        return new Promise((resolve, reject) => {
            this._gsound.play_full(
                {'event.id': name},
                cancellable,
                (source, res) => {
                    try {
                        resolve(source.play_full_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _gsoundLoopSound(name, cancellable) {
        while (!cancellable.is_cancelled())
            await this._gsoundPlaySound(name, cancellable);
    }

    _gdkPlaySound(name, cancellable) {
        if (this._display === undefined)
            this._display = Gdk.Display.get_default();

        let count = 0;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            try {
                if (count++ < 4 && !cancellable.is_cancelled()) {
                    this._display.beep();
                    return GLib.SOURCE_CONTINUE;
                }

                return GLib.SOURCE_REMOVE;
            } catch (e) {
                logError(e);
                return GLib.SOURCE_REMOVE;
            }
        });

        return !cancellable.is_cancelled();
    }

    _gdkLoopSound(name, cancellable) {
        this._gdkPlaySound(name, cancellable);
        GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1500,
            this._gdkPlaySound.bind(this, name, cancellable)
        );
    }

    async playSound(name, cancellable) {
        try {
            if (!(cancellable instanceof Gio.Cancellable))
                cancellable = new Gio.Cancellable();

            this._playing.add(cancellable);

            switch (this.backend) {
                case 'gsound':
                    await this._gsoundPlaySound(name, cancellable);
                    break;

                case 'canberra':
                    await this._canberraPlaySound(name, cancellable);
                    break;

                default:
                    await this._gdkPlaySound(name, cancellable);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        } finally {
            this._playing.delete(cancellable);
        }
    }

    async loopSound(name, cancellable) {
        try {
            if (!(cancellable instanceof Gio.Cancellable))
                cancellable = new Gio.Cancellable();

            this._playing.add(cancellable);

            switch (this.backend) {
                case 'gsound':
                    await this._gsoundLoopSound(name, cancellable);
                    break;

                case 'canberra':
                    await this._canberraLoopSound(name, cancellable);
                    break;

                default:
                    await this._gdkLoopSound(name, cancellable);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        } finally {
            this._playing.delete(cancellable);
        }
    }

    destroy() {
        for (let cancellable of this._playing)
            cancellable.cancel();
    }
};


/**
 * The service class for this component
 */
var Component = Player;

