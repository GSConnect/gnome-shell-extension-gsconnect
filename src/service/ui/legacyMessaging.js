'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Contacts = imports.service.ui.contacts;
const Messaging = imports.service.ui.messaging;
const URI = imports.service.utils.uri;


var Dialog = GObject.registerClass({
    GTypeName: 'GSConnectLegacyMessagingDialog',
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
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/legacy-messaging-dialog.ui',
    Children: [
        'infobar', 'stack',
        'message-box', 'message-avatar', 'message-label', 'entry',
    ],
}, class Dialog extends Gtk.Dialog {

    _init(params) {
        super._init({
            application: Gio.Application.get_default(),
            device: params.device,
            plugin: params.plugin,
            use_header_bar: true,
        });

        this.set_response_sensitive(Gtk.ResponseType.OK, false);

        // Dup some functions
        this.headerbar = this.get_titlebar();
        this._setHeaderBar = Messaging.Window.prototype._setHeaderBar;

        // Info bar
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

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

        // Set the message if given
        if (params.message) {
            this.message = params.message;
            this.addresses = params.message.addresses;

            this.message_avatar.contact = this.device.contacts.query({
                number: this.addresses[0].address,
            });
            this.message_label.label = URI.linkify(this.message.body);
            this.message_box.visible = true;

        // Otherwise set the address(es) if we were passed those
        } else if (params.addresses) {
            this.addresses = params.addresses;
        }

        // Load the contact list if we weren't supplied with an address
        if (this.addresses.length === 0) {
            this.contact_chooser = new Contacts.ContactChooser({
                device: this.device,
            });
            this.stack.add_named(this.contact_chooser, 'contact-chooser');
            this.stack.child_set_property(this.contact_chooser, 'position', 0);

            this._numberSelectedId = this.contact_chooser.connect(
                'number-selected',
                this._onNumberSelected.bind(this)
            );

            this.stack.visible_child_name = 'contact-chooser';
        }

        this.restoreGeometry('legacy-messaging-dialog');

        this.connect('destroy', this._onDestroy);
    }

    _onDestroy(dialog) {
        if (dialog._numberSelectedId !== undefined) {
            dialog.contact_chooser.disconnect(dialog._numberSelectedId);
            dialog.contact_chooser.destroy();
        }

        dialog.entry.buffer.disconnect(dialog._entryChangedId);
        dialog.device.disconnect(dialog._connectedId);
    }

    vfunc_delete_event() {
        this.saveGeometry();

        return false;
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only texts
            if (!this.entry.buffer.text.trim())
                return;

            this.plugin.sendMessage(
                this.addresses,
                this.entry.buffer.text,
                1,
                true
            );
        }

        this.destroy();
    }

    get addresses() {
        if (this._addresses === undefined)
            this._addresses = [];

        return this._addresses;
    }

    set addresses(addresses = []) {
        this._addresses = addresses;

        // Set the headerbar
        this._setHeaderBar(this._addresses);

        // Show the message editor
        this.stack.visible_child_name = 'message-editor';
        this._onStateChanged();
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

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    _onNumberSelected(chooser, number) {
        let contacts = chooser.getSelected();

        this.addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });
    }

    _onStateChanged() {
        if (this.device.connected &&
            this.entry.buffer.text.trim() &&
            this.stack.visible_child_name === 'message-editor')
            this.set_response_sensitive(Gtk.ResponseType.OK, true);
        else
            this.set_response_sensitive(Gtk.ResponseType.OK, false);
    }

    /**
     * Set the contents of the message entry
     *
     * @param {string} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.buffer.text = text;
    }
});

