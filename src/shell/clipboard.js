'use strict';

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Meta = imports.gi.Meta;
const St = imports.gi.St;


/*
 * DBus Interface Info
 */
const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';
const DBUS_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.gnome.Shell.Extensions.GSConnect.Clipboard">
    <property name="Text" type="s" access="readwrite"/>
  </interface>
</node>
`);
const DBUS_INFO = DBUS_NODE.lookup_interface(DBUS_NAME);


/* GSConnectShellClipboard:
 *
 * A simple clipboard portal, especially useful on Wayland where GtkClipboard
 * doesn't work correctly.
 */
var Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectShellClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        )
    }
}, class GSConnectShellClipboard extends GjsPrivate.DBusImplementation {

    _init(params = {}) {
        super._init({
            g_interface_info: DBUS_INFO
        });

        this._text = '';
        this._transferring = false;

        // Get the current clipboard content
        this.clipboard.get_text(
            St.ClipboardType.CLIPBOARD,
            this._onTextReceived.bind(this)
        );

        // Watch global selection
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed',
            this._onOwnerChanged.bind(this)
        );

        // Prepare DBus interface
        this._handlePropertyGetId = this.connect(
            'handle-property-get',
            this._onHandlePropertyGet.bind(this)
        );

        this._handlePropertySetId = this.connect(
            'handle-property-set',
            this._onHandlePropertySet.bind(this)
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

    get clipboard() {
        if (this._clipboard === undefined) {
            this._clipboard = St.Clipboard.get_default();
        }

        return this._clipboard;
    }

    get text() {
        if (this._text === undefined) {
            this._text = '';
        }

        return this._text;
    }

    set text(content) {
        if (typeof content !== 'string')
            return;

        if (this._text !== content) {
            this._text = content;
            this.notify('text');

            this.emit_property_changed(
                'Text',
                GLib.Variant.new('s', content)
            );
        }
    }

    _onTextReceived(clipboard, text) {
        try {
            this.text = text;
        } catch (e) {
            logError(e);
        } finally {
            this._transferring = false;
        }
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

        /* We need to put our transfer call in an idle callback to ensure that
         * Mutter's internal calls have finished resolving in the loop, or else
         * we'll end up with the previous selection's content.
         */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.clipboard.get_text(
                St.ClipboardType.CLIPBOARD,
                this._onTextReceived.bind(this)
            );

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

    _onHandlePropertyGet(iface, name) {
        if (name !== 'Text') return;

        try {
            return new GLib.Variant('s', this.text);
        } catch (e) {
            logError(e);
        }
    }

    _onHandlePropertySet(iface, name, value) {
        if (name !== 'Text') return;

        try {
            let content = value.unpack();

            if (typeof content !== 'string')
                return;

            if (this._text !== content) {
                this._text = content;
                this.notify('text');

                this.clipboard.set_text(
                    St.ClipboardType.CLIPBOARD,
                    content
                );
            }
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        if (this.__disposed === undefined) {
            this._selection.disconnect(this._ownerChangedId);
            this._selection = null;

            Gio.bus_unown_name(this._nameId);

            this.flush();
            this.unexport();
            this.disconnect(this._handlePropertyGetId);
            this.disconnect(this._handlePropertySetId);

            this.run_dispose();
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
            if (_portal === null) {
                _portal = new Clipboard();
            }
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

    if (_portal !== null) {
        _portal.destroy();
        _portal = null;
    }
}

