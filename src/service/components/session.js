// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;


const Session = class {
    constructor() {
        this._connection = Gio.DBus.system;
        this._session = null;

        this._initAsync();
    }

    async _initAsync() {
        try {
            const reply = await this._connection.call(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'ListSessions',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null);

            const sessions = reply.deepUnpack()[0];
            const userName = GLib.get_user_name();
            let sessionPath = '/org/freedesktop/login1/session/auto';

            // eslint-disable-next-line no-unused-vars
            for (const [num, uid, name, seat, objectPath] of sessions) {
                if (name === userName) {
                    sessionPath = objectPath;
                    break;
                }
            }

            this._session = new Gio.DBusProxy({
                g_connection: this._connection,
                g_name: 'org.freedesktop.login1',
                g_object_path: sessionPath,
                g_interface_name: 'org.freedesktop.login1.Session',
            });
            await this._session.init_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            this._session = null;
            logError(e);
        }
    }

    get idle() {
        if (this._session === null)
            return false;

        return this._session.get_cached_property('IdleHint').unpack();
    }

    get locked() {
        if (this._session === null)
            return false;

        return this._session.get_cached_property('LockedHint').unpack();
    }

    get active() {
        // Active if not idle and not locked
        return !(this.idle || this.locked);
    }

    destroy() {
        this._session = null;
    }
};


/**
 * The service class for this component
 */
var Component = Session;

