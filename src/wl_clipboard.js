// SPDX-FileCopyrightText: JingMatrix https://github.com/JingMatrix
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as DBus from './service/utils/dbus.js';

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
    <method name="GetValue">
      <arg direction="in" type="s" name="mimetype"/>
      <arg direction="out" type="ay" name="value"/>
    </method>
    <method name="SetValue">
      <arg direction="in" type="ay" name="value"/>
      <arg direction="in" type="s" name="mimetype"/>
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
         * Run wl-paste with {@link args} and return its output.
         *
         * @param {string[]} args - Arguments for wl-paste
         * @returns {Promise<GLib.Bytes>} The output of wl-paste
         */
        _wlPaste(args) {
            return new Promise((resolve, reject) => {
                const proc = Gio.Subprocess.new(['wl-paste', ...args],
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE);

                proc.communicate_async(null, null, (proc, res) => {
                    try {
                        const [, stdout] = proc.communicate_finish(res);

                        if (proc.get_successful())
                            resolve(stdout);
                        else
                            reject(new Error(`wl-paste exited with ${proc.get_exit_status()}`));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }

        /**
         * Get the available mimetypes of the current clipboard content
         *
         * @returns {Promise<string[]>} A list of mime-types
         */
        async _getMimetypes() {
            try {
                const bytes = await this._wlPaste(['--list-types']);
                const output = new TextDecoder().decode(bytes.toArray());

                return output.split('\n').filter(type => type.length > 0);
            } catch {
                // wl-paste fails if the clipboard is empty
                return [];
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
        async GetMimetypesAsync(params, invocation) {
            const mimetypes = await this._getMimetypes();

            invocation.return_value(new GLib.Variant('(as)', [mimetypes]));
        }

        /**
         * Get the text content of the clipboard
         *
         * @param {Array} params - empty
         * @param {Gio.DBusMethodInvocation} invocation - Text content of the
         *  clipboard is returned via. invocation
         * @returns {Promise<void>}
         */
        async GetTextAsync(params, invocation) {
            const mimetypes = await this._getMimetypes();
            const mimetype = TEXT_MIMETYPES.find(type => mimetypes.includes(type));

            if (mimetype === undefined)
                throw new Error('text not available');

            const bytes = await this._wlPaste(['--no-newline', '--type', mimetype]);
            const text = new TextDecoder().decode(bytes.toArray());

            invocation.return_value(new GLib.Variant('(s)', [text]));
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

            this._wlCopy(new TextEncoder().encode(text));
        }

        /**
         * Run wl-copy with {@link value} as input.
         *
         * @param {Uint8Array} value - The value to copy
         * @param {string} [mimetype] - The mimetype of the value, inferred by
         *   wl-copy if not given
         */
        _wlCopy(value, mimetype = null) {
            const argv = ['wl-copy'];

            if (mimetype !== null)
                argv.push('--type', mimetype);

            // wl-copy forks to serve the clipboard, so its output is
            // silenced to avoid waiting for the fork to exit
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);

            proc.communicate_async(new GLib.Bytes(value), null, (proc, res) => {
                try {
                    proc.communicate_finish(res);
                } catch (e) {
                    logError(e);
                }
            });
        }

        /**
         * Get the content of the clipboard with the type {@link params}.
         *
         * @param {Array} params - [mimetype]
         * @param {Gio.DBusMethodInvocation} invocation - The content of the
         *  clipboard is returned via. invocation
         * @returns {Promise<void>}
         */
        async GetValueAsync(params, invocation) {
            const [mimetype] = params;
            const bytes = await this._wlPaste(['--no-newline', '--type', mimetype]);

            invocation.return_value(GLib.Variant.new_tuple([
                GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
            ]));
        }

        /**
         * Set the content of the clipboard to {@link value} with the type
         * {@link mimetype}.
         *
         * @param {Uint8Array} value - the value to set
         * @param {string} mimetype - the mimetype of the value
         * @returns {void}
         */
        SetValue(value, mimetype) {
            this._wlCopy(value, mimetype);
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
