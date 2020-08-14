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
            let userName = GLib.get_user_name();
            let sessions = await this._listSessions();
            let sessionPath = '/org/freedesktop/login1/session/auto';

            // eslint-disable-next-line no-unused-vars
            for (let [num, uid, name, seat, objectPath] of sessions) {
                if (name === userName) {
                    sessionPath = objectPath;
                    break;
                }
            }

            this._session = await this._getSession(sessionPath);
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

    _listSessions() {
        return new Promise((resolve, reject) => {
            this._connection.call(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'ListSessions',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _getSession(objectPath) {
        let session = new Gio.DBusProxy({
            g_connection: this._connection,
            g_name: 'org.freedesktop.login1',
            g_object_path: objectPath,
            g_interface_name: 'org.freedesktop.login1.Session',
        });

        // Initialize the proxy
        await new Promise((resolve, reject) => {
            session.init_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (proxy, res) => {
                    try {
                        resolve(proxy.init_finish(res));
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });

        return session;
    }

    destroy() {
        this._session = null;
    }
};


/**
 * The service class for this component
 */
var Component = Session;

