// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib} = imports.gi;


var Component = class MockPlayer {

    constructor() {
        this._playing = new Set();
    }

    async playSound(name, cancellable) {
        try {
            if (!(cancellable instanceof Gio.Cancellable))
                cancellable = new Gio.Cancellable();

            this._playing.add(cancellable);

            await new Promise((resolve, reject) => {
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    if (cancellable.is_cancelled()) {
                        const error = new Gio.IOErrorEnum({
                            code: Gio.IOErrorEnum.CANCELLED,
                            message: 'Operation Cancelled',
                        });

                        reject(error);
                    } else {
                        resolve();
                    }

                    return GLib.SOURCE_REMOVE;
                });
            });
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

            while (!cancellable.is_cancelled())
                await this.playSound(name, cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        } finally {
            this._playing.delete(cancellable);
        }
    }
};

