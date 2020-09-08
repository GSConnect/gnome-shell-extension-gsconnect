'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const URI = imports.service.utils.uri;


/**
 * A dialog for repliable notifications.
 */
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
        ),
        'uuid': GObject.ParamSpec.string(
            'uuid',
            'UUID',
            'The notification reply UUID',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/notification-reply-dialog.ui',
    Children: ['infobar', 'notification-title', 'notification-body', 'entry'],
}, class ReplyDialog extends Gtk.Dialog {

    _init(params) {
        super._init({
            application: Gio.Application.get_default(),
            device: params.device,
            plugin: params.plugin,
            uuid: params.uuid,
            use_header_bar: true,
        });

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
        this.notification_body.label = URI.linkify(params.notification.text);

        // Message Entry/Send Button
        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        this._connectedId = this.device.connect(
            'notify::connected',
            this._onStateChanged.bind(this)
        );

        this._entryChangedId = this.entry.buffer.connect(
            'changed',
            this._onStateChanged.bind(this)
        );

        this.restoreGeometry('notification-reply-dialog');

        this.connect('destroy', this._onDestroy);
    }

    _onDestroy(dialog) {
        dialog.entry.buffer.disconnect(dialog._entryChangedId);
        dialog.device.disconnect(dialog._connectedId);
    }

    vfunc_delete_event() {
        this.saveGeometry();

        return false;
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only messages
            if (!this.entry.buffer.text.trim())
                return;

            this.plugin.replyNotification(
                this.uuid,
                this.entry.buffer.text
            );
        }

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

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    _onStateChanged() {
        if (this.device.connected && this.entry.buffer.text.trim())
            this.set_response_sensitive(Gtk.ResponseType.OK, true);
        else
            this.set_response_sensitive(Gtk.ResponseType.OK, false);
    }
});

