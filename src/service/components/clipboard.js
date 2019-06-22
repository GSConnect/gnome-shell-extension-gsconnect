'use strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
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
                           Gio.SubprocessFlags.STDERR_PIPE
                });
                this._proc.init(null);
                
                // IO Channels
                this._stdin = new Gio.DataOutputStream({
                    base_stream: this._proc.get_stdin_pipe(),
                    byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
                });
                
                this._stdout = new Gio.DataInputStream({
                    base_stream: this._proc.get_stdout_pipe(),
                    byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
                });

                this._stderr = new Gio.DataInputStream({
                    base_stream: this._proc.get_stderr_pipe(),
                    byte_order: Gio.DataStreamByteOrder.HOST_ENDIAN
                });
                
                // Watch for premature exits
                this._proc.wait_check_async(null, this._procExit.bind(this));

                // Watch for clipboard content
                let source = this._stdout.base_stream.create_source(null);
                source.set_callback(this._readContent.bind(this));
                source.attach(null);
                
                // Watch for errors
                this._readError(this._stderr);
                
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
            let length = this._stdout.read_int32(null);
            let text = this._stdout.read_bytes(length, null).toArray();

            if (text instanceof Uint8Array) {
                text = imports.byteArray.toString(text);
            }
            
            this._buffer = text;
            this._proxyOwnerChange();

            return true;
        } catch (e) {
            // Silence errors; we get our errors from stderr directly
        }
    }
    
    _readError(stderr) {
        stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                let line = stream.read_line_finish_utf8(res)[0];
                
                if (line !== null) {
                    debug(`XClipboard: ${line}`);
                    this._readError(stream);
                }
            } catch (e) {
                // Silence errors; we get our errors from stderr directly
            }
        });
    }
    
    _writeContent(text) {
        // Bail if xclipboard failed
        if (!this._proc) {
            warning('XClipboard not running');
            return;
        }
        
        try {
            this._stdin.put_int32(text.length, null);
            this._stdin.put_string(text, null);
        } catch (e) {
            debug(e, 'XClipboard');
        }
    }
    
    _procExit(proc, res) {
        try {
            this._proc = null;
            this._stdin.close(null);
            this._stdin = null;
            this._stdout.close(null);
            this._stdout = null;
            this._stderr.close(null);
            this._stderr = null;
            
            proc.wait_check_finish(res);
        } catch (e) {
            debug(e, 'XClipboard');
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
            this._proc.force_exit();
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

