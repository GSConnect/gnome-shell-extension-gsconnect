'use strict';

const ByteArray = imports.byteArray;

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Meta = imports.gi.Meta;


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
var Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectShellClipboard',
}, class GSConnectShellClipboard extends GjsPrivate.DBusImplementation {

    _init(params = {}) {
        super._init({
            g_interface_info: DBUS_INFO,
        });

        this._transferring = false;

        // Watch global selection
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed',
            this._onOwnerChanged.bind(this)
        );

        // Prepare DBus interface
        this._handleMethodCallId = this.connect(
            'handle-method-call',
            this._onHandleMethodCall.bind(this)
        );

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
            this.emit_signal('OwnerChange', null);
            this._transferring = false;

            return GLib.SOURCE_REMOVE;
        });
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
                retval = new GLib.Variant(
                    `(${args.map(arg => arg.signature).join('')})`,
                    (args.length === 1) ? [retval] : retval
                );
            }

            invocation.return_value(retval);

        // Without a response, the client will wait for timeout
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.gjs.JSError.ValueError',
                'Service implementation returned an incorrect value type'
            );
        }
    }

    /**
     * Get the available mimetypes of the current clipboard content
     *
     * @return {Promise<string[]>} A list of mime-types
     */
    GetMimetypes() {
        return new Promise((resolve, reject) => {
            try {
                const mimetypes = this._selection.get_mimetypes(
                    Meta.SelectionType.SELECTION_CLIPBOARD
                );

                resolve(mimetypes);
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Get the text content of the clipboard
     *
     * @return {Promise<string>} Text content of the clipboard
     */
    GetText() {
        return new Promise((resolve, reject) => {
            const mimetypes = this._selection.get_mimetypes(
                Meta.SelectionType.SELECTION_CLIPBOARD);

            let mimetype = mimetypes.find(type => TEXT_MIMETYPES.includes(type));

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

                            resolve(ByteArray.toString(bytearray));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } else {
                reject(new Error('text not available'));
            }
        });
    }

    /**
     * Set the text content of the clipboard
     *
     * @param {string} text - text content to set
     * @return {Promise} A promise for the operation
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

                const source = Meta.SelectionSourceMemory.new(
                    'text/plain;charset=utf-8', GLib.Bytes.new(text));

                this._selection.set_owner(
                    Meta.SelectionType.SELECTION_CLIPBOARD, source);

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
     * @return {Promise<Uint8Array>} The content of the clipboard
     */
    GetValue(mimetype) {
        return new Promise((resolve, reject) => {
            const stream = Gio.MemoryOutputStream.new_resizable();

            this._selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD,
                mimetype, -1,
                stream, null,
                (selection, res) => {
                    try {
                        selection.transfer_finish(res);

                        const bytes = stream.steal_as_bytes();

                        resolve(bytes.get_data());
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Set the content of the clipboard to @value with the type @mimetype.
     *
     * @param {Uint8Array} value - the value to set
     * @param {string} mimetype - the mimetype of the value
     * @return {Promise} - A promise for the operation
     */
    SetValue(value, mimetype) {
        return new Promise((resolve, reject) => {
            try {
                const source = Meta.SelectionSourceMemory.new(mimetype,
                    GLib.Bytes.new(value));

                this._selection.set_owner(
                    Meta.SelectionType.SELECTION_CLIPBOARD, source);

                resolve();
            } catch (e) {
                reject(e);
            }
        });
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

        if (this._handleMethodCallId > 0) {
            this.disconnect(this._handleMethodCallId);
            this._handleMethodCallId = 0;
            this.unexport();
        }
    }
});


var _portal = null;
var _portalId = 0;

/**
 * Watch for the service to start and export the clipboard portal when it does.
 */
function watchService() {
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
function unwatchService() {
    if (_portalId > 0) {
        Gio.bus_unwatch_name(_portalId);
        _portalId = 0;
    }
}

