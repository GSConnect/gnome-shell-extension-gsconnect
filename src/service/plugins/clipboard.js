'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: ['kdeconnect.clipboard'],
    outgoingCapabilities: ['kdeconnect.clipboard'],
    actions: {
        clipboardCopy: {
            label: _('Clipboard Copy'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard']
        },
        clipboardPaste: {
            label: _('Clipboard Paste'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: []
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
            this._onLocalClipboardChanged.bind(this)
        );
    }

    handlePacket(packet) {
        if (packet.body.hasOwnProperty('content')) {
            this._onRemoteClipboardChanged(packet.body.content);
        }
    }

    /**
     * Store the updated clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard, event) {
        clipboard.request_text((clipboard, text) => {
            debug(`${this.device.name}: ${text}`);

            this._localContent = text;

            if (this.settings.get_boolean('send-content')) {
                this.clipboardCopy();
            }
        });
    }

    /**
     * Store the updated clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(text) {
        debug(`${this.device.name}: ${text}`);

        this._remoteContent = text;

        if (this.settings.get_boolean('receive-content')) {
            this.clipboardPaste();
        }
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    clipboardCopy() {
        if (this._remoteContent !== this._localContent) {
            this._remoteContent = this._localContent;

            this.device.sendPacket({
                id: 0,
                type: 'kdeconnect.clipboard',
                body: { content: this._localContent }
            });
        }
    }

    /**
     * Paste from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPaste() {
        if (this._localContent !== this._remoteContent) {
            this._localContent = this._remoteContent;

            this._clipboard.set_text(this._remoteContent, -1);
        }
    }

    destroy() {
        this._clipboard.disconnect(this._ownerChangeId);

        super.destroy();
    }
});

