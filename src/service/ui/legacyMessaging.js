// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import * as Contacts from '../ui/contacts.js';
import * as URI from '../utils/uri.js';
import '../utils/ui.js';


const Dialog = GObject.registerClass({
    GTypeName: 'GSConnectLegacyMessagingDialog',
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
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/legacy-messaging-dialog.ui',
    Children: [
        'infobar', 'stack', 'avatar', 'message-editor',
        'message-label', 'entry', 'title-widget', 'send-text'
    ],
    Signals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    },
}, class Dialog extends Adw.ApplicationWindow {

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
        if (this.message) {
            this.message_label.label = URI.linkify(this.message.body);
        } 

        // Load the contact list if we weren't supplied with an address
        if (this.addresses !== undefined && this.addresses.length === 0) {
            this.contact_chooser = new Contacts.ContactChooser({
                device: this.device,
            });
            this.stack.add_named(this.contact_chooser, 'contact-chooser');
            //this.stack.child_set_property(this.contact_chooser, 'position', 0);

            this._numberSelectedId = this.contact_chooser.connect(
                'number-selected',
                this._onNumberSelected.bind(this)
            );

            this.stack.visible_child_name = 'contact-chooser';
        }

        this.restoreGeometry('legacy-messaging-dialog');
    }

    vfunc_close_request() {
        this.response = Gtk.ResponseType.CANCEL;

        if (this._numberSelectedId !== undefined) {
            this.contact_chooser.disconnect(this._numberSelectedId);
            this.stack.remove(this.contact_chooser);
            this.contact_chooser.run_dispose();
        }

        this.entry.buffer.disconnect(this._entryChangedId);
        this.device.disconnect(this._connectedId);
        
        this.saveGeometry();

        return false;
    }

    set response(response_id) {
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
        this.emit('response', this, response_id);
        this.close();
    }

    get addresses() {
        if (this._addresses === undefined)
            this._addresses = [];

        return this._addresses;
    }

    set addresses(addresses = []) {
        this._addresses = addresses;
        
        const contact = this.device.contacts.query({
            number: addresses[0].address,
        });
        
        this.title_widget.title = contact.name,
        this.title_widget.subtitle = Contacts.getDisplayNumber(contact, addresses[0].address)
        this.avatar.text = contact.name;
        

        // Show the message editor
        this.stack.visible_child = this.message_editor;
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

    _sendMessage() {
        this.response = Gtk.ResponseType.OK;
    }

    _on_emoji_picked(widget, emoticon) {
        const text = this.entry.buffer.text;
        this.entry.buffer.text = text + emoticon;
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
        const contacts = chooser.getSelected();

        this.addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });
    }

    _onStateChanged() {
        if (this.device.connected &&
            this.entry.buffer.text.trim())
            this.send_text.sensitive = true;
        else
            this.send_text.sensitive = false;
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

export default Dialog;
