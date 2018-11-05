'use strict';

const Gdk = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Clipboard'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: ['kdeconnect.clipboard'],
    outgoingCapabilities: ['kdeconnect.clipboard'],
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
            let display = Gdk.Display.get_default();
            this._clipboard = Gtk.Clipboard.get_default(display);
        } catch (e) {
            this.destroy();
            throw e;
        }

        // Buffer content to allow selective sync
        this._localBuffer = '';
        this._remoteBuffer = '';

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
            this._localBuffer = text;

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
        if (this._remoteBuffer !== this._localBuffer) {
            this._remoteBuffer = this._localBuffer;

            this.device.sendPacket({
                type: 'kdeconnect.clipboard',
                body: {content: this._localBuffer}
            });
        }
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        if (this._localBuffer !== this._remoteBuffer) {
            this._localBuffer = this._remoteBuffer;

            this._clipboard.set_text(this._remoteBuffer, -1);
        }
    }

    destroy() {
        this._clipboard.disconnect(this._ownerChangeId);

        super.destroy();
    }
});

