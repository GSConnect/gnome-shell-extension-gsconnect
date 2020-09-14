'use strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;


const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';


var Clipboard = GObject.registerClass({
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

        if (this._clipboard instanceof Gtk.Clipboard)
            this._clipboard.set_text(content, -1);

        if (this._clipboard instanceof Gio.DBusProxy)
            this._proxySetText(content);
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

            await new Promise((resolve, reject) => {
                this._clipboard.init_async(
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                    (proxy, res) => {
                        try {
                            resolve(proxy.init_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            this._ownerChangeId = this._clipboard.connect(
                'g-signal',
                this._onOwnerChange.bind(this)
            );

            this._onOwnerChange();
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
        this._clipboard = Gtk.Clipboard.get_default(display);

        this._ownerChangeId = this._clipboard.connect(
            'owner-change',
            this._onOwnerChange.bind(this)
        );

        this._onOwnerChange();
    }

    async _onOwnerChange() {
        try {
            if (this._clipboard instanceof Gtk.Clipboard)
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
    _proxyGetMimetypes() {
        return new Promise((resolve, reject) => {
            this._clipboard.call(
                'GetMimetypes',
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                this._cancellable,
                (proxy, res) => {
                    try {
                        const reply = proxy.call_finish(res);
                        resolve(reply.deepUnpack()[0]);
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });
    }

    _proxyGetText() {
        return new Promise((resolve, reject) => {
            this._clipboard.call(
                'GetText',
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                this._cancellable,
                (proxy, res) => {
                    try {
                        const reply = proxy.call_finish(res);
                        resolve(reply.deepUnpack()[0]);
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                }
            );
        });
    }

    _proxySetText(text) {
        this._clipboard.call(
            'SetText',
            new GLib.Variant('(s)', [text]),
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            this._cancellable,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    Gio.DBusError.strip_remote_error(e);
                    debug(e);
                }
            }
        );
    }

    async _proxyUpdateText() {
        const mimetypes = await this._proxyGetMimetypes();

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return this._applyUpdate('');

        // Special case to ignore copied files
        if (mimetypes.includes('text/uri-list'))
            return;

        const text = await this._proxyGetText();

        this._applyUpdate(text);
    }

    /*
     * GtkClipboard
     */
    _gtkGetMimetypes() {
        return new Promise((resolve, reject) => {
            this._clipboard.request_targets((clipboard, atoms) => resolve(atoms));
        });
    }

    _gtkGetText() {
        return new Promise((resolve, reject) => {
            this._clipboard.request_text((clipboard, text) => resolve(text));
        });
    }

    async _gtkUpdateText() {
        const mimetypes = await this._gtkGetMimetypes();

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return this._applyUpdate('');

        // Special case to ignore copied files
        if (mimetypes.includes('text/uri-list'))
            return;

        const text = await this._gtkGetText();

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
    }
});


/**
 * The service class for this component
 */
var Component = Clipboard;

