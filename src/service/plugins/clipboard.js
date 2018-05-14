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
        clipboardCopy: {
            summary: _('Clipboard Copy'),
            description: _('Copy from local clipboard to remote clipboard'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard'],
            allow: 4
        },
        clipboardPaste: {
            summary: _('Clipboard Paste'),
            description: _('Paste from remote clipboard to local clipboard'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: [],
            allow: 2
        }
    },
    events: {
        clipboardUpdateLocal: {
            summary: _('Clipboard Update (Local)'),
            description: _('The local clipboard changed'),
            icon_name: 'edit-paste-symbolic',
            incoming: ['kdeconnect.clipboard'],
            outgoing: ['kdeconnect.clipboard']
        },
        clipboardUpdateRemote: {
            summary: _('Clipboard Update (Remote)'),
            description: _('The remote clipboard changed'),
            icon_name: 'edit-paste-symbolic',
            incoming: ['kdeconnect.clipboard'],
            outgoing: ['kdeconnect.clipboard']
        }
    }
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

        this._localContent = '';
        this._remoteContent = '';

        // Watch local clipboard for changes
        this._ownerChangeId = this._clipboard.connect(
            'owner-change',
            this._updateLocal.bind(this)
        );
    }

    handlePacket(packet) {
        debug(packet);

        if (packet.body.content) {
            this._updateRemote(packet.body.content);
        }
    }

    /**
     * Remote Methods
     */
    _updateLocal(clipboard, event) {
        clipboard.request_text((clipboard, text) => {
            debug(text);

            this._localContent = text;
            this._eventActions('clipboardUpdateLocal', null);
        });
    }

    _updateRemote(text) {
        debug(text);

        this._remoteContent = text;
        this._eventActions('clipboardUpdateRemote', null);
    }

    /**
     * Copy to the remote clipboard
     */
    clipboardCopy() {
        if (this._localContent !== this._remoteContent) {
            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.clipboard',
                body: { content: this._localContent }
            });
        }
    }

    /**
     * Paste from the remote clipboard
     */
    clipboardPaste() {
        if (this._localContent !== this._remoteContent) {
            this._clipboard.set_text(this._remoteContent, -1);
        }
    }

    destroy() {
        this._clipboard.disconnect(this._ownerChangeId);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

