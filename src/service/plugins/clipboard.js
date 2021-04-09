'use strict';

const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Clipboard'),
    description: _('Share the clipboard content'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
    ],
    outgoingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
    ],
    actions: {
        clipboardPush: {
            label: _('Clipboard Push'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard'],
        },
        clipboardPull: {
            label: _('Clipboard Pull'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: [],
        },
    },
};


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._clipboard = Components.acquire('clipboard');

        // Watch local clipboard for changes
        this._textChangedId = this._clipboard.connect(
            'notify::text',
            this._onLocalClipboardChanged.bind(this)
        );

        // Buffer content to allow selective sync
        this._localBuffer = this._clipboard.text;
        this._localTimestamp = 0;
        this._remoteBuffer = null;
    }

    connected() {
        super.connected();

        // TODO: if we're not auto-syncing local->remote, but we are doing the
        //       reverse, it's possible older remote content will end up
        //       overwriting newer local content.
        if (!this.settings.get_boolean('send-content'))
            return;

        if (this._localBuffer === null && this._localTimestamp === 0)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.clipboard.connect',
            body: {
                content: this._localBuffer,
                timestamp: this._localTimestamp,
            },
        });
    }

    handlePacket(packet) {
        if (!packet.body.hasOwnProperty('content'))
            return;

        switch (packet.type) {
            case 'kdeconnect.clipboard':
                this._handleContent(packet);
                break;

            case 'kdeconnect.clipboard.connect':
                this._handleConnectContent(packet);
                break;
        }
    }

    _handleContent(packet) {
        this._onRemoteClipboardChanged(packet.body.content);
    }

    _handleConnectContent(packet) {
        if (packet.body.hasOwnProperty('timestamp') &&
            packet.body.timestamp > this._localTimestamp)
            this._onRemoteClipboardChanged(packet.body.content);
    }

    /*
     * Store the local clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard, pspec) {
        this._localBuffer = clipboard.text;
        this._localTimestamp = Date.now();

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(text) {
        this._remoteBuffer = text;

        if (this.settings.get_boolean('receive-content'))
            this.clipboardPull();
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    clipboardPush() {
        // Don't sync if the clipboard is empty or not text
        if (this._localTimestamp === 0)
            return;

        if (this._remoteBuffer !== this._localBuffer) {
            this._remoteBuffer = this._localBuffer;

            // If the buffer is %null, the clipboard contains non-text content,
            // so we neither clear the remote clipboard nor pass the content
            if (this._localBuffer !== null) {
                this.device.sendPacket({
                    type: 'kdeconnect.clipboard',
                    body: {
                        content: this._localBuffer,
                    },
                });
            }
        }
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        if (this._localBuffer !== this._remoteBuffer) {
            this._localBuffer = this._remoteBuffer;
            this._localTimestamp = Date.now();

            this._clipboard.text = this._remoteBuffer;
        }
    }

    destroy() {
        if (this._clipboard && this._textChangedId) {
            this._clipboard.disconnect(this._textChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});
