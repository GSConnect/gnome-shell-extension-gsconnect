import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';


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
 * GSConnect.Clipboard -> St.Clipboard mapping.
 *
 * Mimetypes that are just plaintext data. Note that image/png does not go here
 * because in Gtk3 image clipboards are handled as GdkPixbuf, so we have to map
 * that to a raw data stream.
 */
const TEXT_TYPES = [
    'text/plain',
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'COMPOUND_TEXT',
];


export const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectShellClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text',
            'The current text content of the clipboard',
            GObject.ParamFlags.READABLE,
            ''
        ),
    },
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();

        this._busId = 0;
        this._text = '';

        this._selection = global.display.get_selection();
        this._selectionId = this._selection.connect(
            'owner-changed',
            this._onOwnerChanged.bind(this)
        );
    }

    _onOwnerChanged(selection, type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        // Try to get standard text content
        const mimetypes = this._getMimetypes();
        const mimetype = TEXT_TYPES.find(type => mimetypes.includes(type));

        if (mimetype === undefined) {
            this._text = '';
            this.emit('owner-changed');
            return;
        }

        /* In Wayland an intermediate GMemoryOutputStream is used which triggers
         * an owner-changed signal. To avoid notifying on incomplete transfers
         * we ignore sources with an active stream.
         *
         * https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/521
         * https://gitlab.gnome.org/GNOME/mutter/issues/727
         */
        if (source && source.stream) {
            this._streamId = source.stream.connect('notify::is-closed', (stream) => {
                source.stream.disconnect(this._streamId);
                this._streamId = 0;

                this._getSelectionText(mimetype);
            });
        } else {
            this._getSelectionText(mimetype);
        }
    }

    _getSelectionText(mimetype) {
        this._selection.transfer_async(
            Meta.SelectionType.SELECTION_CLIPBOARD,
            mimetype,
            -1,
            null,
            (selection, res) => {
                try {
                    const stream = selection.transfer_finish(res);

                    this._readTextAsync(stream);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'GSConnect: Failed to transfer clipboard');
                }
            }
        );
    }

    _readTextAsync(stream) {
        const reader = new Gio.DataInputStream({
            base_stream: stream,
            close_base_stream: true,
        });

        reader.read_upto_async('\0', 1, 0, null, (reader, res) => {
            try {
                const [text, length] = reader.read_upto_finish(res);

                this._text = text || '';
                this.emit('owner-changed');
            } catch (e) {
                logError(e);
            } finally {
                reader.close_async(0, null, null);
            }
        });
    }

    /*
     * D-Bus Export
     */
    export(connection, object_path) {
        this._busId = connection.register_object(
            object_path,
            DBUS_INFO,
            this._onHandleMethodCall.bind(this),
            this._onHandlePropertyGet.bind(this),
            this._onHandlePropertySet.bind(this)
        );

        this._ownerChangeId = this.connect('owner-changed', () => {
            connection.emit_signal(
                null,
                DBUS_PATH,
                DBUS_NAME,
                'OwnerChange',
                null
            );
        });

        this.emit('owner-changed');
    }

    unexport() {
        if (this._ownerChangeId > 0) {
            this.disconnect(this._ownerChangeId);
            this._ownerChangeId = 0;
        }

        if (this._busId > 0) {
            const connection = Gio.DBus.session;
            connection.unregister_object(this._busId);
            this._busId = 0;
        }
    }

    /*
     * DBus/Method Call
     */
    watchService() {
        return Gio.DBus.session.watch_name(
            'org.gnome.Shell.Extensions.GSConnect',
            Gio.BusNameWatcherFlags.NONE,
            this._onBusAcquired.bind(this),
            this._onNameLost.bind(this)
        );
    }

    unwatchService(watcherId) {
        Gio.DBus.session.unwatch_name(watcherId);
    }

    watchServiceAsync() {
        return Gio.DBus.session.watch_name(
            'org.gnome.Shell.Extensions.GSConnect',
            Gio.BusNameWatcherFlags.NONE,
            (connection, name) => {
                this.export(connection, DBUS_PATH);
            },
            (connection, name) => {
                this.unexport();
            }
        );
    }

    _onBusAcquired(connection, name) {
        try {
            this.export(connection, DBUS_PATH);
        } catch (e) {
            logError(e);
        }
    }

    _onNameLost(connection, name) {
        try {
            this.unexport();
        } catch (e) {
            logError(e);
        }
    }

    async _onHandleMethodCall(iface, name, parameters, invocation) {
        let retval;

        try {
            const args = parameters.recursiveUnpack();

            retval = await this[name](...args);
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                if (!e.name.includes('.'))
                    e.name = `org.gnome.gjs.JSError.${e.name}`;

                invocation.return_dbus_error(e.name, e.message);
            }

            return;
        }

        if (retval === undefined)
            retval = new GLib.Variant('()', []);

        try {
            if (!(retval instanceof GLib.Variant)) {
                const args = DBUS_INFO.lookup_method(name).out_args;

                if (args.length === 1)
                    retval = new GLib.Variant(`(${args[0].signature})`, [retval]);
                else
                    retval = new GLib.Variant(`(${args.map(a => a.signature).join('')})`, retval);
            }

            invocation.return_value(retval);
        } catch (e) {
            logError(e, `GSConnect: Error returning ${DBUS_NAME}.${name}()`);
        }
    }

    _onHandlePropertyGet(iface, name, property) {
        return null;
    }

    _onHandlePropertySet(iface, name, property, value) {
        return false;
    }

    /*
     * D-Bus API
     */

    _getMimetypes() {
        return this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
    }

    /**
     * Get a list of mimetypes available in the clipboard.
     *
     * @returns {Promise<string[]>} A list of mimetypes
     */
    GetMimetypes() {
        return Promise.resolve(this._getMimetypes());
    }

    /**
     * Get the text content of the clipboard.
     *
     * @returns {Promise<string>} The text content of the clipboard
     */
    GetText() {
        return Promise.resolve(this._text);
    }

    /**
     * Set the text content of the clipboard
     *
     * @param {string} text - text content to set
     * @returns {Promise} A promise for the operation
     */
    SetText(text) {
        return new Promise((resolve, reject) => {
            try {
                if (typeof text !== 'string') {
                    throw new Gio.DBusError({
                        code: Gio.DBusError.INVALID_ARGS,
                        message: 'expected string',
                    });
                }

                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                // Verify clipboard content and fall back to older Meta.Selection if needed
                clipboard.get_text(St.ClipboardType.CLIPBOARD,
                    (clip, currentText) => {
                        if (currentText !== text) {
                            const source = Meta.SelectionSourceMemory.new(
                                'text/plain;charset=utf-8', GLib.Bytes.new(text));
                            this._selection.set_owner(
                                Meta.SelectionType.SELECTION_CLIPBOARD, source);
                        }
                    });

                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Get the content of the clipboard with the type @mimetype.
     *
     * @param {string} mimetype - the mimetype to request
     * @returns {Promise<Uint8Array>} The content of the clipboard
     */
    GetValue(mimetype) {
        return new Promise((resolve, reject) => {
            try {
                if (!this._getMimetypes().includes(mimetype)) {
                    throw new Gio.DBusError({
                        code: Gio.DBusError.INVALID_ARGS,
                        message: `mimetype '${mimetype}' not in clipboard`,
                    });
                }

                this._selection.transfer_async(
                    Meta.SelectionType.SELECTION_CLIPBOARD,
                    mimetype,
                    -1,
                    null,
                    (selection, res) => {
                        try {
                            const stream = selection.transfer_finish(res);

                            this._readValueAsync(stream, resolve, reject);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    _readValueAsync(stream, resolve, reject) {
        const stream_out = Gio.MemoryOutputStream.new_resizable();

        stream_out.splice_async(
            stream,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
            Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            0,
            null,
            (stream_out, res) => {
                try {
                    stream_out.splice_finish(res);
                    const bytes = stream_out.steal_as_bytes().toArray();
                    resolve(bytes);
                } catch (e) {
                    reject(e);
                }
            }
        );
    }

    /**
     * Set the content of the clipboard.
     *
     * @param {Uint8Array} value - The content to set
     * @param {string} mimetype - The mimetype of the content
     * @returns {Promise} A promise for the operation
     */
    SetValue(value, mimetype) {
        return new Promise((resolve, reject) => {
            try {
                if (!(value instanceof Uint8Array)) {
                    throw new Gio.DBusError({
                        code: Gio.DBusError.INVALID_ARGS,
                        message: 'expected byte array',
                    });
                }

                if (typeof mimetype !== 'string') {
                    throw new Gio.DBusError({
                        code: Gio.DBusError.INVALID_ARGS,
                        message: 'expected string',
                    });
                }

                const source = Meta.SelectionSourceMemory.new(
                    mimetype, GLib.Bytes.new(value));

                this._selection.set_owner(
                    Meta.SelectionType.SELECTION_CLIPBOARD, source);

                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }
});
