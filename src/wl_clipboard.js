// SPDX-FileCopyrightText: JingMatrix https://github.com/JingMatrix
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as DBus from './service/utils/dbus.js';

// laucher for wl-clipboard
const launcher = new Gio.SubprocessLauncher({
    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
});

/*
 * DBus Interface Info
 */
const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';
const DBUS_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.gnome.Shell.Extensions.GSConnect.Clipboard">
    <!-- Methods -->
    <method name="GetMimetypes">
      <arg direction="out" type="as" name="mimetypes"/>
    </method>
    <method name="GetText">
      <arg direction="out" type="s" name="text"/>
    </method>
    <method name="SetText">
      <arg direction="in" type="s" name="text"/>
    </method>

    <!-- Signals -->
    <signal name="OwnerChange"/>
  </interface>
</node>
`);
const DBUS_INFO = DBUS_NODE.lookup_interface(DBUS_NAME);

/*
 * Text Mimetypes
 */
const TEXT_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];

/* GSConnectClipboardPortal:
 *
 * A simple clipboard portal, especially useful on Wayland where GtkClipboard
 * doesn't work in the background.
 */
export const Clipboard = GObject.registerClass(
    {
        GTypeName: 'GSConnectShellClipboard',
    },
    class GSConnectShellClipboard extends GObject.Object {
        _init() {
            super._init();

            this._transferring = false;

            this.watcher = Gio.Subprocess.new([
                'wl-paste',
                '-w',
                'dbus-send',
                DBUS_PATH,
                '--dest=' + DBUS_NAME,
                DBUS_NAME + '.OwnerChange',
            ], Gio.SubprocessFlags.NONE);

            // Prepare DBus interface
            this._dbus = DBus.wrapObject(DBUS_INFO, this);

            this._nameId = Gio.DBus.own_name(
                Gio.BusType.SESSION,
                DBUS_NAME,
                Gio.BusNameOwnerFlags.NONE,
                this._onBusAcquired.bind(this),
                null,
                this._onNameLost.bind(this)
            );
        }

        _onBusAcquired(connection, name) {
            try {
                this._dbus.export(connection, DBUS_PATH);
            } catch (e) {
                logError(e);
            }
        }

        _onNameLost(connection, name) {
            try {
                this._dbus.unexport();
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Get the available mimetypes of the current clipboard content
         *
         * @param {Array} params - empty
         * @param {Gio.DBusMethodInvocation} invocation - List of mime-types is
         *  returned via. invocation
         * @returns {Promise<void>}
         */
        GetMimetypesAsync(params, invocation) {
            return new Promise((resolve, reject) => {
                const proc = launcher.spawnv([
                    'wl-paste',
                    '--list-types',
                    '-n',
                ]);
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] =
                            proc.communicate_utf8_finish(res);
                        if (proc.get_successful())
                            resolve(stdout.trim().split('\n'));
                        else
                            logError(stderr);

                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .then((value) => invocation.return_value(new GLib.Variant('(as)', [value])));
        }

        /**
         * Get the text content of the clipboard
         *
         * @param {Array} params - empty
         * @param {Gio.DBusMethodInvocation} invocation - Text content of the
         *  clipboard is returned via. invocation
         * @returns {Promise<void>}
         */
        GetTextAsync(params, invocation) {
            return new Promise((resolve, reject) => {
                this.GetMimetypes().then((mimetypes) => {
                    const mimetype = TEXT_MIMETYPES.find((type) =>
                        mimetypes.includes(type)
                    );

                    if (mimetype !== undefined) {
                        const proc = launcher.spawnv(['wl-paste', '-n']);
                        proc.communicate_utf8_async(null, null, (proc, res) => {
                            try {
                                const [, stdout, stderr] =
                                    proc.communicate_utf8_finish(res);
                                if (proc.get_successful())
                                    resolve(stdout);
                                else
                                    logError(stderr);

                            } catch (e) {
                                reject(e);
                            }
                        });
                    } else {
                        reject(new Error('text not available'));
                    }
                });
            })
            .then((value) => invocation.return_value(new GLib.Variant('(s)', [value])));
        }

        /**
         * Set the text content of the clipboard
         *
         * @param {string} text - text content to set
         * @returns {void}
         */
        SetText(text) {
            if (typeof text !== 'string') {
                throw new Gio.DBusError({
                    code: Gio.DBusError.INVALID_ARGS,
                    message: 'expected string',
                });
            }

            launcher.spawnv(['wl-copy', text]);
        }



        destroy() {
            if (this._nameId > 0) {
                Gio.bus_unown_name(this._nameId);
                this._nameId = 0;
            }

            try {
                this._dbus.unexport();
            } catch (e) {
                logError(e);
            }
            if (this.watcher)
                this.watcher.force_exit();

        }
    }
);

let _portal = null;
let _portalId = 0;

/**
 * Watch for the service to start and export the clipboard portal when it does.
 */
export function watchService() {
    if (_portalId > 0)
        return;

    _portalId = Gio.bus_watch_name(
        Gio.BusType.SESSION,
        'org.gnome.Shell.Extensions.GSConnect',
        Gio.BusNameWatcherFlags.NONE,
        () => {
            if (_portal === null)
                _portal = new Clipboard();
        },
        () => {
            if (_portal !== null) {
                _portal.destroy();
                _portal = null;
            }
        }
    );
}

/**
 * Stop watching the service and export the portal if currently running.
 */
export function unwatchService() {
    if (_portalId > 0) {
        Gio.bus_unwatch_name(_portalId);
        _portalId = 0;
    }
}

// vim:tabstop=2:shiftwidth=2:expandtab
