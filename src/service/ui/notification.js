// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import * as URI from '../utils/uri.js';
import '../utils/ui.js';


/**
 * A dialog for repliable notifications.
 */
const ReplyDialog = GObject.registerClass({
    GTypeName: 'GSConnectNotificationReplyDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin that owns this notification',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'uuid': GObject.ParamSpec.string(
            'uuid',
            'UUID',
            'The notification reply UUID',
            GObject.ParamFlags.READWRITE,
            null
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/notification-reply-dialog.ui',
    Children: ['title-widget', 'infobar', 'notification-title', 'notification-body', 'entry', 'send-text'],
    Signals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    }
}, class ReplyDialog extends Adw.ApplicationWindow {

    _init(params) {
        super._init();
        Object.assign(this, params);

        // Info bar
        this.device.bind_property(
            'connected',
            this.infobar,
            'revealed',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Notification Data
        this.title_widget.title = this.notification.appName;
        this.title_widget.subtitle = this.device.name;

        this.notification_title.label = this.notification.title;
        this.notification_body.label = URI.linkify(this.notification.text);
        
        this.device.bind_property(
            'connected',
            this.send_text,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        this._connectedId = this.device.connect(
            'notify::connected',
            this._onStateChanged.bind(this)
        );

        this._entryChangedId = this.entry.buffer.connect(
            'inserted-text',
            this._onStateChanged.bind(this)
        );
        this._entryChangedId = this.entry.buffer.connect(
            'deleted-text',
            this._onStateChanged.bind(this)
        );

        this.restoreGeometry('notification-reply-dialog');
    }

    vfunc_close_request() {
        this.entry.buffer.disconnect(this._entryChangedId);
        this.device.disconnect(this._connectedId);
        this.emit('response', this, Gtk.ResponseType.CANCEL);
        this.saveGeometry();
        return false;
    }

    set response(response) {
        if (response === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only messages
            if (!this.entry.buffer.text.trim())
                return;

            this.plugin.replyNotification(
                this.uuid,
                this.entry.buffer.text
            );
        }
        this.emit('response', this, response);
        this.destroy();
    }

    get device() {
        if (this._device === undefined)
            this._device = null;

        return this._device;
    }

    set device(device) {
        this._device = device;
    }

    get plugin() {
        if (this._plugin === undefined)
            this._plugin = null;

        return this._plugin;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get uuid() {
        if (this._uuid === undefined)
            this._uuid = null;

        return this._uuid;
    }

    set uuid(uuid) {
        this._uuid = uuid;

        // We must have a UUID
        if (!uuid) {
            this.destroy();
            debug('no uuid for repliable notification');
        }
    }

    _sendMessage() {
        this.response = Gtk.ResponseType.OK;
    }

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    _onEmojiPicked(widget, emoticon) {
        const text = this.entry.get_text();
        this.entry.set_text(text + emoticon);
    }

    _onStateChanged() {
        if (this.device.connected && this.entry.buffer.text.trim())
            this.send_text.sensitive = true;
        else
            this.send_text.sensitive = false;
    }
});

export default ReplyDialog;
