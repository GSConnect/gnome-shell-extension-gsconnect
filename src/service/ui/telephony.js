'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Contacts = imports.service.ui.contacts;
const Messaging = imports.service.ui.messaging;


var Dialog = GObject.registerClass({
    GTypeName: 'GSConnectLegacyMessagingDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/telephony.ui',
    Children: [
        'infobar', 'stack',
        'message', 'message-box', 'message-entry'
    ]
}, class Dialog extends Gtk.Dialog {

    _init(params) {
        this.connect_template();
        super._init({
            application: Gio.Application.get_default(),
            device: params.device,
            use_header_bar: true,
            visible: true
        });

        this.set_response_sensitive(Gtk.ResponseType.OK, false);

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

        // Set the message if given
        if (params.message) {
            this.message = params.message;
            let message = new Messaging.ConversationMessage(this.message);
            message.margin_bottom = 12;
            this.message_box.add(message);
        }

        // Set the address if given
        if (params.address) {
            this.address = params.address;

        // Otherwise load the contact list
        } else {
            this.contact_list = new Contacts.ContactChooser({
                device: this.device,
                store: this.device.contacts
            });
            this.stack.add_named(this.contact_list, 'contact-list');
            this.stack.child_set_property(this.contact_list, 'position', 0);

            this._numberSelectedId = this.contact_list.connect(
                'number-selected',
                this._onNumberSelected.bind(this)
            );

            this.stack.visible_child_name = 'contact-list';
        }

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only texts
            if (!this.message_entry.buffer.text.trim()) return;

            this.sms.sendSms(this.address, this.message_entry.buffer.text);
        }

        this.destroy();
    }

    get address() {
        return this._address || null;
    }

    set address(value) {
        if (!value) return;

        this._address = value;

        let headerbar = this.get_titlebar();
        headerbar.title = this.contact.name;
        headerbar.subtitle = value;

        // See if we have a nicer display number
        let number = value.toPhoneNumber();

        for (let contactNumber of this.contact.numbers) {
            let cnumber = contactNumber.value.toPhoneNumber();

            if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                headerbar.subtitle = contactNumber.value;
                break;
            }
        }

        this.stack.visible_child_name = 'message';
        this._onStateChanged();
    }

    get contact() {
        // Ensure we have a contact and hold a reference to it
        if (!this._contact) {
            this._contact = this.device.contacts.query({number: this.address});
        }

        return this._contact;
    }

    get sms() {
        if (!this._sms) {
            this._sms = this.device.lookup_plugin('sms');
        }

        return this._sms;
    }

    _onDestroy(window) {
        if (window._numberSelectedId) {
            window.contact_list.disconnect(window._numberSelectedId);
        }

        window.device.disconnect(window._connectedId);
        window.message_entry.buffer.disconnect(window._entryChangedId);
        window.disconnect_template();
    }

    _onNumberSelected(list, number) {
        this.address = number;
    }

    _onStateChanged() {
        switch (false) {
            case this.device.connected:
            case (this.message_entry.buffer.text.trim() !== ''):
            case (this.stack.visible_child_name === 'message'):
                this.set_response_sensitive(Gtk.ResponseType.OK, false);
                break;

            default:
                this.set_response_sensitive(Gtk.ResponseType.OK, true);
        }
    }

    /**
     * Set the contents of the message entry
     *
     * @param {String} text - The message to place in the entry
     */
    setMessage(text) {
        this.message_entry.buffer.text = text;
    }
});

