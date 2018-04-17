'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: ['kdeconnect.clipboard'],
    outgoingCapabilities: ['kdeconnect.clipboard'],
    actions: {
        provideClipboard: {
            summary: _('Provide Clipboard'),
            description: _('Provide clipboard update'),
            signature: 'av',
            incoming: ['kdeconnect.clipboard'],
            outgoing: ['kdeconnect.clipboard']
        }
    },
    events: {}
};


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._display = Gdk.Display.get_default();

        if (this._display === null) {
            this.destroy();
            throw Error(_('Failed to get Gdk.Display'));
        }

        this._clipboard = Gtk.Clipboard.get_default(this._display);

        if (this._clipboard === null) {
            this.destroy();
            throw Error(_('Failed to get Clipboard'));
        }

        this._clipboard.connect('owner-change', (clipboard, event) => {
            this._clipboard.request_text((clipboard, text) => {
                // FIXME
                if (!(this.allow & 2)) {
                    debug('Operation not permitted');
                    return;
                }

                this.provideClipboard(text);
            });
        });
    }

    handlePacket(packet) {
        debug(packet);

        if (packet.body.content && (this.allow & 4)) {
            this._handleContent(packet.body.content);
        }
    }

    /**
     * Remote Methods
     */
    _handleContent(text) {
        debug(text);

        this._currentContent = text;
        this._clipboard.set_text(text, -1);
    }

    /**
     * Local Methods
     */
    provideClipboard(text) {
        if (text !== this._currentContent) {
            debug(text);

            this._currentContent = text;

            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.clipboard',
                body: { content: text }
            });
        }
    }

    destroy() {
        GObject.signal_handlers_destroy(this._clipboard);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

