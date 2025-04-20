// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';


const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';


/**
 * The service class for this component
 */
const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();
        this._cancellable = new Gio.Cancellable();
        this._clipboard = null;

        this._ownerChangeId = 0;
        this._nameWatcherId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            this._onNameAppeared.bind(this),
            this._onNameVanished.bind(this)
        );
    }

    get text() {
        if (this._text === undefined)
            this._text = '';
        return this._text;
    }

    set text(content) {
        if (this.text === content)
            return;

        this._text = content;
        this.notify('text');

        if (typeof content !== 'string')
            return;

        if (this._clipboard instanceof Gdk.Clipboard)
            this._clipboard.set_text(content, -1);

        if (this._clipboard instanceof Gio.DBusProxy) {
            this._clipboard.call('SetText', new GLib.Variant('(s)', [content]),
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable)
                .catch(debug);
        }
    }

    async _onNameAppeared(connection, name, name_owner) {
        try {
            // Cleanup the GtkClipboard
            if (this._clipboard && this._ownerChangeId > 0) {
                this._clipboard.disconnect(this._ownerChangeId);
                this._ownerChangeId = 0;
            }

            // Create a proxy for the remote clipboard
            this._clipboard = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: DBUS_NAME,
                g_object_path: DBUS_PATH,
                g_interface_name: DBUS_NAME,
                g_flags: Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            });

            await this._clipboard.init_async(GLib.PRIORITY_DEFAULT,
                this._cancellable);

            this._ownerChangeId = this._clipboard.connect('g-signal',
                this._onOwnerChange.bind(this));

            this._onOwnerChange();
            if (!globalThis.HAVE_GNOME) {
                // Directly subscrible signal
                this.signalHandler = Gio.DBus.session.signal_subscribe(
                    null,
                    DBUS_NAME,
                    'OwnerChange',
                    DBUS_PATH,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    this._onOwnerChange.bind(this)
                );
            }

        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                debug(e);
                this._onNameVanished(null, null);
            }
        }
    }

    _onNameVanished(connection, name) {
        if (this._clipboard && this._ownerChangeId > 0) {
            this._clipboard.disconnect(this._ownerChangeId);
            this._clipboardChangedId = 0;
        }

        const display = Gdk.Display.get_default();
        this._clipboard = Gdk.Clipboard.get_default(display);

        this._ownerChangeId = this._clipboard.connect('owner-change',
            this._onOwnerChange.bind(this));

        this._onOwnerChange();
    }

    async _onOwnerChange() {
        try {
            if (this._clipboard instanceof Gdk.Clipboard)
                await this._gtkUpdateText();

            else if (this._clipboard instanceof Gio.DBusProxy)
                await this._proxyUpdateText();
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e);
        }
    }

    _applyUpdate(text) {
        if (typeof text !== 'string' || this.text === text)
            return;

        this._text = text;
        this.notify('text');
    }

    /*
     * Proxy Clipboard
     */
    async _proxyUpdateText() {
        let reply = await this._clipboard.call('GetMimetypes', null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
        const mimetypes = reply.deepUnpack()[0];

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return this._applyUpdate('');

        // Special case to ignore copied files
        if (mimetypes.includes('text/uri-list'))
            return;

        reply = await this._clipboard.call('GetText', null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
        const text = reply.deepUnpack()[0];

        this._applyUpdate(text);
    }

    /*
     * GtkClipboard
     */
    async _gtkUpdateText() {
        const mimetypes = await new Promise((resolve, reject) => {
            this._clipboard.request_targets((clipboard, atoms) => resolve(atoms));
        });

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return this._applyUpdate('');

        // Special case to ignore copied files
        if (mimetypes.includes('text/uri-list'))
            return;

        const text = await new Promise((resolve, reject) => {
            this._clipboard.request_text((clipboard, text) => resolve(text));
        });

        this._applyUpdate(text);
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();

        if (this._clipboard && this._ownerChangeId > 0) {
            this._clipboard.disconnect(this._ownerChangeId);
            this._ownerChangedId = 0;
        }

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }

        if (!globalThis.HAVE_GNOME && this.signalHandler)
            Gio.DBus.session.signal_unsubscribe(this.signalHandler);
    }
});

export default Clipboard;

// vim:tabstop=2:shiftwidth=2:expandtab
