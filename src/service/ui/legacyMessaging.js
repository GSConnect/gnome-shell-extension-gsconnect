// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import * as Contacts from '../ui/contacts.js';
import * as URI from '../utils/uri.js';
import '../utils/ui.js';

/**
 * Dialog - A legacy messaging window for GSConnect.
 *
 * This dialog allows the user to send SMS messages via a connected device,
 * select a contact, compose messages, and manage the sending flow.
 *
 * @class GSConnectLegacyMessagingDialog
 * @extends Adw.ApplicationWindow
 * @property {object} device - The device associated with this dialog.
 * @property {object} plugin - The plugin providing messaging features.
 * @event response
 * @param {object} dialog - The Dialog instance emitting the signal.
 * @param {number} responseId - The response identifier (e.g., OK or CANCEL).
 */
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
        'infobar', 'nav-view', 'message-avatar', 'message-editor',
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
            'inserted-text',
            this._onStateChanged.bind(this)
        );
        this._entryChangedId = this.entry.buffer.connect(
            'deleted-text',
            this._onStateChanged.bind(this)
        );
    
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device,
        });
        this.contact_chooser.show_back_button = false;
        this.nav_view.push(this.contact_chooser);
        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );
        
        this.restoreGeometry('legacy-messaging-dialog');
    }

    /**
     * Handle window close request.
     *
     * @returns {boolean} False to allow the window to close.
     */
    vfunc_close_request() {
        this.response = Gtk.ResponseType.CANCEL;

        if (this._numberSelectedId !== undefined) {
            this.contact_chooser.disconnect(this._numberSelectedId);
        }
        this.entry.buffer.disconnect(this._entryChangedId);
        this.device.disconnect(this._connectedId);
        this.saveGeometry();

        return false;
    }

    /**
     * Set the response to close or confirm the dialog.
     *
     * @type {number} response_id - The Gtk.ResponseType.
     */
    set response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            // Refuse to send empty or whitespace only texts
            if (!this.entry.buffer.text.trim())
                return;

            this.plugin.sendMessage(
                this.addresses,
                this.entry.buffer.text,
                1
            );
        }
        this.emit('response', this, response_id);
        this.destroy();
    }
 
    /**
     * Set a new incoming message to display in the dialog.
     *
     * @type {object} message - The message object with body and title.
     */
    set message(message) {
        this.message_label.label = URI.linkify(message.body);
        this.message_avatar.visible = true;
        
        const sender = message.title || 'unknown';
        const contact = this.device.contacts.query({
            name: sender,
        });
        if(contact) {
            this.addresses = [{ address :contact.numbers[0].value }];  
        } else {
            this.title_widget.title = sender;  
        }
        this.nav_view.pop();
    }

    /**
     * Getter and Setter for currently selected addresses.
     *
     * @type {Array<{address: string}>} List of selected addresses.
     */
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
        this.message_avatar.text = contact.name;
        this.message_avatar.visible = true;

        this._onStateChanged();
    }

    /**
     * Getter and Setter the associated device.
     *
     * @type {object} The device object.
     */
    get device() {
        if (this._device === undefined)
            this._device = null;

        return this._device;
    }

    set device(device) {
        this._device = device;
    }


    /**
     * Getter and Setter the associated plugin.
     *
     * @type {object} The plugin object.
     */
    get plugin() {
        if (this._plugin === undefined)
            this._plugin = null;

        return this._plugin;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }
    /**
     * Trigger sending the current message.
     *
     * @private
     */
    _sendMessage() {
        this.response = Gtk.ResponseType.OK;
    }

    /**
     * Handle emoji selection and insert into message.
     *
     * @private
     * @param {Gtk.Widget} widget - The widget triggering the event.
     * @param {string} emoticon - The selected emoji/emoticon.
     */
    _onEmojiPicked(widget, emoticon) {
        const text = this.entry.buffer.text;
        this.entry.buffer.text = text + emoticon;
    }

    /**
     * Handle activation of a hyperlink inside the message.
     *
     * @private
     * @param {Gtk.Label} label - The label widget.
     * @param {string} uri - The URI to open.
     * @returns {boolean} True if handled.
     */
    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    /**
     * Handle selection of a number from the contact chooser.
     *
     * @private
     * @param {object} chooser - The ContactChooser instance.
     * @param {object} number - The selected number.
     */
    _onNumberSelected(chooser, number) {
        const contacts = chooser.getSelected();
        this.addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });
        this.nav_view.pop();
    }

    /**
     * Update the state of the entry and send button based on connection and input.
     *
     * @private
     */
    _onStateChanged() {
        if (this.device.connected) {
            this.entry.sensitive = true;
            if (this.entry.buffer.text.trim().length > 1) {
                this.send_text.sensitive = true;
            } else {
                this.send_text.sensitive = false;
            }
        } else {
            this.entry.sensitive = false;
            this.send_text.sensitive = false;
        }
    }

    /**
     * Set the contents of the message entry manually.
     *
     * @param {string} text - The message text to set.
     */
    setMessage(text) {
        this.entry.buffer.text = text;
    }
});

export default Dialog;
