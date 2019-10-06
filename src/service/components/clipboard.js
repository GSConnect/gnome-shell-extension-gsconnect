'use strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;


var Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            null
        )
    }
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();
        
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
            this._text = null;
        }

        return this._text;
    }

    set text(content) {
        if (this.text !== content) {
            this._text = content;
            this.notify('text');

            this._setText(content);
        }
    }

    _onTextReceived(clipboard, text) {
        this.text = text;
    }

    _onTargetsReceived(clipboard, atoms) {
        // Empty clipboard
        if (atoms === null) {
            return this.text = '';
        }

        let hasText = false;

        for (let type of Array.from(atoms)) {
            if (type === 'UTF8_STRING') {
                hasText = true;
                continue;
            }

            // Serialized text formats
            if (type === 'text/html')
                return this.text = null;

            if (type === 'text/rdf' || type === 'text/richtext')
                return this.text = null;

            // URI list
            if (type === 'text/uri-list')
                return this.text = null;

            // Image
            if (type.startsWith('image/'))
                return this.text = null;
        }

        if (hasText) {
            clipboard.request_text(this._onTextReceived.bind(this));
        } else {
            this.text = '';
        }
    }

    _onOwnerChange(clipboard, event) {
        clipboard.request_targets(this._onTargetsReceived.bind(this));
    }

    _readContent() {
        try {
            // Read the message
            let length = this._stdout.read_int32(null);

            // We're being sent text content
            if (length > 0) {
                let text = this._stdout.read_bytes(length, null).toArray();

                if (text instanceof Uint8Array) {
                    text = imports.byteArray.toString(text);
                }

                this.text = `${text}`;

            // The clipboard was cleared
            } else if (length === 0) {
                this.text = '';

            // The clipboard contains non-text content
            } else {
                this.text = null;
            }

            return true;
        } catch (e) {
            debug(e);
            return false;
        }
    }
    
    _readError(stderr) {
        stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                let line = stream.read_line_finish_utf8(res)[0];
                
                if (line !== null) {
                    logError(new Error(line), 'XClipboard Proxy');
                    this._readError(stream);
                }
            } catch (e) {
                debug(e);
            }
        });
    }
    
    _writeContent(text) {
        // Bail if xclipboard failed
        if (!this._proc) {
            logError(new Error('XClipboard not running'));
            return;
        }

        try {
            if (text === null) {
                this._stdin.put_int32(-1, null);
            } else {
                this._stdin.put_int32(text.length, null);
                this._stdin.put_string(text, null);
            }
        } catch (e) {
            debug(e, 'XClipboard Proxy');
        }
    }
    
    _procExit(proc, res) {
        try {
            this._proc = null;
            this._stdin = this._stdin.close(null);
            this._stdout = this._stdout.close(null);
            this._stderr = this._stderr.close(null);
            
            proc.wait_check_finish(res);
        } catch (e) {
            logError(e, 'XClipboard Proxy');
        }
    }
    
    _setText(text) {
        try {
            // If we're using the XWayland subprocess, we'll ostensibly write
            // anything, so even if it's %null the value can be buffered
            if (_WAYLAND) {
                this._writeContent(text);

            // If we're wrapping GtkClipboard, we only set actual text content
            } else if (text !== null) {
                this._clipboard.set_text(text, -1);
            }
        } catch (e) {
            logError(e);
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
var Component = Clipboard;

