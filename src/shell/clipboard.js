// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Meta from 'gi://Meta';

import * as DBus from '../service/utils/dbus.js';


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
export const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectShellClipboard',
    Signals: {
        'OwnerChange': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [],
        },
    },
}, class GSConnectShellClipboard extends GObject.Object {

    _init(params = {}) {
        super._init();

        this._transferring = false;

        // Watch global selection
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed',
            this._onOwnerChanged.bind(this)
        );

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

    _onOwnerChanged(selection, type, source) {
        /* We're only interested in the standard clipboard */
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        /* In Wayland an intermediate GMemoryOutputStream is used which triggers
         * a second ::owner-changed emission, so we need to ensure we ignore
         * that while the transfer is resolving.
         */
        if (this._transferring)
            return;

        this._transferring = true;

        /* We need to put our signal emission in an idle callback to ensure that
         * Mutter's internal calls have finished resolving in the loop, or else
         * we'll end up with the previous selection's content.
         */
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.emit('OwnerChange');
            this._transferring = false;

            return GLib.SOURCE_REMOVE;
        });
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
     * @returns {string[]} A list of mime-types
     */
    GetMimetypes() {
        const mimetypes = this._selection.get_mimetypes(
            Meta.SelectionType.SELECTION_CLIPBOARD
        );

        return mimetypes;
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
            const mimetypes = this._selection.get_mimetypes(
                Meta.SelectionType.SELECTION_CLIPBOARD);

            const mimetype = TEXT_MIMETYPES.find(type => mimetypes.includes(type));

            if (mimetype !== undefined) {
                const stream = Gio.MemoryOutputStream.new_resizable();

                this._selection.transfer_async(
                    Meta.SelectionType.SELECTION_CLIPBOARD,
                    mimetype, -1,
                    stream, null,
                    (selection, res) => {
                        try {
                            selection.transfer_finish(res);

                            const bytes = stream.steal_as_bytes();
                            const bytearray = bytes.get_data();

                            resolve(new TextDecoder().decode(bytearray));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } else {
                reject(new Error('text not available'));
            }
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

        const source = Meta.SelectionSourceMemory.new(
            'text/plain;charset=utf-8', GLib.Bytes.new(text));

        this._selection.set_owner(
            Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    /**
     * Get the content of the clipboard with the type {@link params}.
     *
     * @param {Array} params - [mimetype]
     * @param {Gio.DBusMethodInvocation} invocation - The content of the
     *  clipboard is returned via. invocation
     * @returns {Promise<void>}
     */
    GetValueAsync(params, invocation) {
        const [mimetype] = params;

        return new Promise((resolve, reject) => {
            const mimetypes = this._selection.get_mimetypes(
                Meta.SelectionType.SELECTION_CLIPBOARD);

            if (!mimetypes.includes(mimetype)) {
                reject(new Gio.DBusError({
                    code: Gio.DBusError.INVALID_ARGS,
                    message: `${mimetype} not available`,
                }));
                return;
            }

            const stream = Gio.MemoryOutputStream.new_resizable();

            this._selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD,
                mimetype, -1,
                stream, null,
                (selection, res) => {
                    try {
                        selection.transfer_finish(res);

                        resolve(stream.steal_as_bytes());
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        })
        .then((bytes) => invocation.return_value(GLib.Variant.new_tuple([
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
        ])));
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
        const source = Meta.SelectionSourceMemory.new(mimetype,
            GLib.Bytes.new(value));

        this._selection.set_owner(
            Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    destroy() {
        if (this._selection && this._ownerChangedId > 0) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }

        if (this._nameId > 0) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }

        try {
            this._dbus.unexport();
        } catch (e) {
            logError(e);
        }
    }
});


let _portal = null;
let _portalId = 0;

/**
 * Watch for the service to start and export the clipboard portal when it does.
 */
export function watchService() {
    if (GLib.getenv('XDG_SESSION_TYPE') !== 'wayland')
        return;

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
