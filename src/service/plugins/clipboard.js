'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Clipboard'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect'
    ],
    outgoingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect'
    ],
    actions: {
        clipboardPush: {
            label: _('Clipboard Push'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard']
        },
        clipboardPull: {
            label: _('Clipboard Pull'),
            icon_name: 'edit-copy-symbolic',

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

        try {
            this._clipboard = this.service.components.get('clipboard');

            // Watch local clipboard for changes
            this._ownerChangeId = this._clipboard.connect(
                'owner-change',
                this._onLocalClipboardChanged.bind(this)
            );
        } catch (e) {
            this.destroy();
            throw e;
        }

        // Buffer content to allow selective sync
        this._localBuffer = '';
        this._localTimestamp = 0;
        this._remoteBuffer = '';
    }

    connected() {
        super.connected();

        if (this._localBuffer && this._localTimestamp) {
            this.device.sendPacket({
                type: 'kdeconnect.clipboard.connect',
                body: {
                    content: this._localBuffer,
                    timestamp: this._localTimestamp
                }
            });
        }
    }

    handlePacket(packet) {
        if (!packet.body.hasOwnProperty('content')) return;

        if (packet.type === 'kdeconnect.clipboard') {
            this._handleContent(packet);
        } else if (packet.type === 'kdeconnect.clipboard.connect') {
            this._handleConnectContent(packet);
        }
    }

    _handleContent(packet) {
        this._onRemoteClipboardChanged(packet.body.content);
    }

    _handleConnectContent(packet) {
        if (packet.body.hasOwnProperty('timestamp') &&
            packet.body.timestamp > this._localTimestamp) {
            this._onRemoteClipboardChanged(packet.body.content);
        }
    }

    /**
     * Store the updated clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard, event) {
        clipboard.request_text((clipboard, text) => {
            this._localBuffer = text;
            this._localTimestamp = Date.now();

            if (this.settings.get_boolean('send-content')) {
                this.clipboardPush();
            }
        });
    }

    /**
     * Store the updated clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(text) {
        this._remoteBuffer = text;

        if (this.settings.get_boolean('receive-content')) {
            this.clipboardPull();
        }
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    clipboardPush() {
        // Don't sync if the clipboard is empty or not text
        if (!this._localBuffer || !this._localTimestamp) return;

        if (this._remoteBuffer !== this._localBuffer) {
            this._remoteBuffer = this._localBuffer;

            this.device.sendPacket({
                type: 'kdeconnect.clipboard',
                body: {
                    content: this._localBuffer
                }
            });
        }
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        if (this._localBuffer !== this._remoteBuffer) {
            this._localBuffer = this._remoteBuffer;
            this._localTimestamp = Date.now();

            this._clipboard.set_text(this._remoteBuffer, -1);
        }
    }

    destroy() {
        if (this._clipboard && this._ownerChangeId) {
            this._clipboard.disconnect(this._ownerChangeId);
        }

        super.destroy();
    }
});

