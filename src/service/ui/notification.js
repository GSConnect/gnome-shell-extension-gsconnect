// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

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
}, class ReplyDialog extends Adw.Window {

    _init(params) {
        super._init({
            application: Gio.Application.get_default(),
            default_width: 320,
            default_height: 300,
        });

        this.device = params.device;
        this.plugin = params.plugin;
        this.uuid = params.uuid;

        this._buildLayout(params.notification);

        // Info bar
        this.device.bind_property(
            'connected',
            this._banner,
            'revealed',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Message Entry/Send Button
        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        this._connectedId = this.device.connect(
            'notify::connected',
            this._onStateChanged.bind(this)
        );

        this._entryChangedId = this.entry.buffer.connect(
            'changed',
            this._onStateChanged.bind(this)
        );
        this._onStateChanged();

        this.restoreGeometry('notification-reply-dialog');

        this.connect('close-request', this._onCloseRequest.bind(this));
    }

    _buildLayout(notification) {
        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
            title_widget: new Adw.WindowTitle({
                title: notification.appName,
                subtitle: this.device.name,
            }),
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this._sendButton = new Gtk.Button({label: _('Send'), sensitive: false});
        this._sendButton.add_css_class('suggested-action');
        this._sendButton.connect('clicked', this._onSend.bind(this));
        header.pack_end(this._sendButton);

        this._banner = new Adw.Banner({title: _('Device is disconnected')});
        toolbar.add_top_bar(this._banner);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        toolbar.set_content(box);

        const title = new Gtk.Label({
            label: notification.title,
            xalign: 0,
            wrap: true,
            selectable: true,
        });
        title.add_css_class('heading');
        box.append(title);

        const body = new Gtk.Label({
            label: URI.linkify(notification.text),
            use_markup: true,
            xalign: 0,
            yalign: 0,
            wrap: true,
            selectable: true,
        });
        body.connect('activate-link', this._onActivateLink.bind(this));
        box.append(body);

        this.entry = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 6,
            bottom_margin: 6,
            left_margin: 6,
            right_margin: 6,
            vexpand: true,
        });
        const frame = new Gtk.ScrolledWindow({
            child: this.entry,
            vexpand: true,
            min_content_height: 80,
        });
        frame.add_css_class('card');
        box.append(frame);

        this.set_focus(this.entry);
    }

    _onCloseRequest() {
        this.saveGeometry();
        this.entry.buffer.disconnect(this._entryChangedId);
        this.device.disconnect(this._connectedId);

        return false;
    }

    _onSend() {
        // Refuse to send empty or whitespace only messages
        if (!this.entry.buffer.text.trim())
            return;

        this.plugin.replyNotification(
            this.uuid,
            this.entry.buffer.text
        );

        this.close();
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

    _onActivateLink(label, uri) {
        Gtk.show_uri(
            this,
            uri.includes('://') ? uri : `https://${uri}`,
            Gdk.CURRENT_TIME
        );

        return true;
    }

    _onStateChanged() {
        this._sendButton.sensitive =
            this.device.connected && !!this.entry.buffer.text.trim();
    }
});

export default ReplyDialog;
