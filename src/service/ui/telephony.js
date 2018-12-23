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

        this.address = params.address || null;

        this.device.bind_property(
            'connected',
            this.message_entry,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        if (params.message) {
            this.message = params.message;
            let message = new Messaging.ConversationMessage(this.message);
            this.message_box.add(message);
        }

        // Message Entry
        this._entryChangedId = this.message_entry.buffer.connect(
            'changed',
            this._onStateChanged.bind(this)
        );

        // Contacts
        this.contact_list = new Contacts.ContactChooser({
            store: this.device.contacts
        });
        this.stack.add_named(this.contact_list, 'contact-list');
        this.stack.child_set_property(this.contact_list, 'position', 0);

        this._numberSelectedId = this.contact_list.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        //
        if (!this.address) {
            this.stack.visible_child_name = 'contact-list';
        }
    }

    get address() {
        return this._address || null;
    }

    set address(value) {
        if (!value) return;

        this._address = value;

        // Ensure we have a contact stored and hold a reference to it
        let contact = this.device.contacts.query({number: value});
        this._contact = contact;

        let headerbar = this.get_titlebar();
        headerbar.title = contact.name;
        headerbar.subtitle = value;

        // See if we have a nicer display number
        let number = value.toPhoneNumber();

        for (let contactNumber of contact.numbers) {
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
        window.message_entry.buffer.disconnect(window._entryChangedId);
        window.contact_list.disconnect(window._numberSelectedId);
        window.disconnect_template();
    }

    _onNumberSelected(list, number) {
        this.address = number;
    }

    _onStateChanged() {
        let state = (
            this.message_entry.buffer.text &&
            this.stack.visible_child_name === 'message'
        );

        this.set_response_sensitive(Gtk.ResponseType.OK, state);
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only texts
            if (!this.entry.buffer.text.trim()) return;

            this.sms.sendMessage(
                this.address,
                this.message_entry.buffer.text
            );
        }

        this.destroy();
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

