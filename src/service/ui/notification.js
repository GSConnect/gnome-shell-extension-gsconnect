'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


var ReplyDialog = GObject.registerClass({
    GTypeName: 'GSConnectNotificationReplyDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin that owns this notification',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/notification-reply-dialog.ui',
    Children: [
        'infobar',
        'notification-title', 'notification-body',
        'message-entry'
    ]
}, class Dialog extends Gtk.Dialog {

    _init(params) {
        this.connectTemplate();
        super._init({
            application: Gio.Application.get_default(),
            device: params.device,
            use_header_bar: true
        });

        this.uuid = params.uuid;

        this.set_response_sensitive(Gtk.ResponseType.OK, false);

        // Info bar
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Notification Data
        let headerbar = this.get_titlebar();
        headerbar.title = params.notification.appName;
        headerbar.subtitle = this.device.name;

        this.notification_title.label = params.notification.title;
        this.notification_body.label = params.notification.text.linkify();

        // Message Entry/Send Button
        this.device.bind_property(
            'connected',
            this.message_entry,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        this._connectedId = this.device.connect(
            'notify::connected',
            this._onStateChanged.bind(this)
        );

        this._entryChangedId = this.message_entry.buffer.connect(
            'changed',
            this._onStateChanged.bind(this)
        );
    }

    vfunc_delete_event() {
        this.device.disconnect(this._connectedId);
        this.message_entry.buffer.disconnect(this._entryChangedId);

        return false;
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only messages
            if (!this.message_entry.buffer.text.trim()) return;

            this.plugin.replyNotification(
                this.uuid,
                this.message_entry.buffer.text
            );
        }

        this.disconnectTemplate();
        this.destroy();
    }

    get uuid() {
        return this._uuid;
    }

    set uuid(uuid) {
        // We must have a UUID
        if (uuid) {
            this._uuid = uuid;
        } else {
            this.destroy();
            warning('no uuid for repliable notification');
        }
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _onStateChanged() {
        switch (false) {
            case this.device.connected:
            case (this.message_entry.buffer.text.trim() !== ''):
                break;

            default:
                this.set_response_sensitive(Gtk.ResponseType.OK, true);
        }
    }
});

