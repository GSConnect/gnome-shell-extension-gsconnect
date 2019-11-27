'use strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;


const ClipboardProxy = GObject.registerClass({
    GTypeName: 'GSConnectClipboardProxy',
    Implements: [Gio.DBusInterface],
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        )
    }
}, class ClipboardProxy extends Gio.DBusProxy {

    _init() {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.gnome.Shell.Extensions.GSConnect.Clipboard',
            g_object_path: '/org/gnome/Shell/Extensions/GSConnect/Clipboard',
            g_interface_name: 'org.gnome.Shell.Extensions.GSConnect.Clipboard'
        });
    }

    vfunc_g_properties_changed(changed, invalidated) {
        let properties = changed.deep_unpack();

        if (properties.hasOwnProperty('Text')) {
            let content = this.get_cached_property('Text').unpack();

            if (this.text !== content) {
                this._text = content;
                this.notify('text');
            }
        }
    }

    get text() {
        if (this._text === undefined) {
            this._text = this.get_cached_property('Text').unpack();
        }

        return this._text;
    }

    set text(content) {
        if (this.text !== content) {
            this._text = content;
            this.notify('text');

            this._setProperty('Text', 's', content);
        }
    }

    _setProperty(name, signature, value) {
        let variant = new GLib.Variant(signature, value);

        this.set_cached_property(name, variant);

        this.call(
            'org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [this.g_interface_name, name, variant]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    destroy() {
        if (this.__disposed === undefined) {
            this.__disposed = true;
            this.run_dispose();
        }
    }
});


var Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        )
    }
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();
        
        try {
            this._clipboard = null;

            // On Wayland we use a small DBus server exported from the Shell
            if (_WAYLAND) {
                this._nameWatcherId = Gio.bus_watch_name(
                    Gio.BusType.SESSION,
                    'org.gnome.Shell.Extensions.GSConnect.Clipboard',
                    Gio.BusNameWatcherFlags.NONE,
                    this._onNameAppeared.bind(this),
                    this._onNameVanished.bind(this)
                );
                
            // If we're in X11/Xorg we're just a wrapper around GtkClipboard
            } else {
                let display = Gdk.Display.get_default();
                this._clipboard = Gtk.Clipboard.get_default(display);
                
                this._ownerChangeId = this._clipboard.connect(
                    'owner-change',
                    this._onOwnerChange.bind(this)
                );
            }
        } catch (e) {
            this.destroy();
            throw e;
        }
    }
    
    get text() {
        if (this._text === undefined) {
            this._text = '';
        }

        return this._text;
    }

    set text(content) {
        if (this.text !== content) {
            this._text = content;
            this.notify('text');

            if (!_WAYLAND && content !== null) {
                this._clipboard.set_text(content, -1);
            }
        }
    }

    async _onNameAppeared(connection, name, name_owner) {
        try {
            this._clipboard = new ClipboardProxy();

            await new Promise((resolve, reject) => {
                this._clipboard.init_async(
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (proxy, res) => {
                        try {
                            proxy.init_finish(res);
                            resolve();
                        } catch (e) {
                            this._clipboard = null;
                            reject(e);
                        }
                    }
                );
            });

            this._clipboard.bind_property(
                'text',
                this,
                'text',
                (GObject.BindingFlags.BIDIRECTIONAL |
                 GObject.BindingFlags.SYNC_CREATE)
            );
        } catch (e) {
            logError(e);
        }
    }

    _onNameVanished(connection, name) {
        try {
            if (this._clipboard !== null) {
                this._clipboard.destroy();
                this._clipboard = null;
            }
        } catch (e) {
            logError(e);
        }
    }

    _onTextReceived(clipboard, text) {
        if (typeof text === 'string' && this.text !== text) {
            this._text = text;
            this.notify('text');
        }
    }

    _onTargetsReceived(clipboard, atoms) {
        // Empty clipboard
        if (atoms.length === 0) {
            this._onTextReceived(clipboard, '');
            return;
        }

        // As a special case we need to ignore copied files (eg. in Nautilus)
        if (atoms.includes('text/uri-list')) {
            return;
        }

        // Let GtkClipboard filter for supported types
        clipboard.request_text(this._onTextReceived.bind(this));
    }

    _onOwnerChange(clipboard, event) {
        clipboard.request_targets(this._onTargetsReceived.bind(this));
    }

    destroy() {
        if (this._nameWatcherId) {
            Gio.bus_unwatch_name(this._nameWatcherId);

            if (this._clipboard !== null) {
                this._clipboard.destroy();
            }
        }
        
        if (this._ownerChangeId) {
            this._clipboard.disconnect(this._ownerChangeId);
        }
    }
});


/**
 * The service class for this component
 */
var Component = Clipboard;

