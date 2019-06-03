'use strict';

const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;


var Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Signals: {
        'owner-change': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        }
    }
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();
        
        this._buffer = null;
        this._proc = null;
        
        try {
            // On Wayland we use a small subprocess running in XWayland where
            // GtkClipboard still functions properly.
            if (_WAYLAND) {
                this._proc = new Gio.Subprocess({
                    argv: [gsconnect.extdatadir + '/service/components/xclipboard'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE |
                           Gio.SubprocessFlags.STDOUT_PIPE |
                           Gio.SubprocessFlags.STDERR_SILENCE
                });
                this._proc.init(null);
                
                // IO Channels
                this._stdin = new Gio.DataInputStream({
                    base_stream: this._proc.get_stdout_pipe(),
                    byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
                });

                this._stdout = new Gio.DataOutputStream({
                    base_stream: this._proc.get_stdin_pipe(),
                    byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
                });

                let source = this._stdin.base_stream.create_source(null);
                source.set_callback(this._readContent.bind(this));
                source.attach(null);
                
            // If we're in X11/Xorg we're just a wrapper around GtkClipboard
            } else {
                let display = Gdk.Display.get_default();
                this._clipboard = Gtk.Clipboard.get_default(display);
                
                this._ownerChangeId = this._clipboard.connect(
                    'owner-change',
                    this._proxyOwnerChange.bind(this)
                );
            }
        } catch (e) {
            logError(e, 'Clipboard');
        }
    }
    
    _proxyOwnerChange(clipboard, event) {
        this.emit('owner-change', '');
    }
    
    _readContent() {
        try {
            // Read the message
            let length = this._stdin.read_int32(null);
            let text = this._stdin.read_bytes(length, null).toArray();

            if (text instanceof Uint8Array) {
                text = imports.byteArray.toString(text);
            }
            
            this._buffer = text;
            this._proxyOwnerChange();

            return true;
        } catch (e) {
            logError(e);
        }
    }
    
    _writeContent(text) {
        try {
            this._stdout.put_int32(text.length, null);
            this._stdout.put_string(text, null);
        } catch (e) {
            logError(e, 'Clipboard');
        }
    }
    
    set_text(text, length) {
        try {
            if (_WAYLAND) {
                this._writeContent(text);
            } else {
                this._clipboard.set_text(text, length);
            }
        } catch (e) {
            logError(e, 'Clipboard');
        }
    }
    
    request_text(callback) {
        try {
            if (_WAYLAND) {
                callback(this, this._buffer);
            } else {
                this._clipboard.request_text(callback);
            }
        } catch (e) {
            logError(e, 'Clipboard');
        }
    }
    
    destroy() {
        if (this._proc) {
            this._proc.force_exit(null);
        }
        
        if (this._ownerChangeId) {
            this._clipboard.disconnect(this._ownerChangeId);
        }
    }
});


/**
 * The service class for this component
 */
var Service = Clipboard;

