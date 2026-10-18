// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Contacts from '../ui/contacts.js';
import * as Messaging from '../ui/messaging.js';
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
}, class Dialog extends Adw.Window {

    _init(params) {
        super._init({
            application: Gio.Application.get_default(),
            device: params.device,
            plugin: params.plugin,
            title: _('Send SMS'),
            default_width: 300,
            default_height: 300,
        });

        this._buildLayout();

        // Dup some functions
        this._setHeaderBar = Messaging.Window.prototype._setHeaderBar;

        // Info bar
        this.device.bind_property(
            'connected',
            this.infobar,
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

            this._numberSelectedId = this.contact_chooser.connect(
                'number-selected',
                this._onNumberSelected.bind(this)
            );

            this.stack.visible_child_name = 'contact-chooser';
        }

        this.restoreGeometry('legacy-messaging-dialog');

        this.connect('close-request', this._onCloseRequest.bind(this));
    }

    _buildLayout() {
        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        // HeaderBar
        this.headerbar = new Adw.WindowTitle({title: _('Send SMS'), subtitle: ''});
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
            title_widget: this.headerbar,
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this._sendButton = new Gtk.Button({label: _('Send'), sensitive: false});
        this._sendButton.add_css_class('suggested-action');
        this._sendButton.connect('clicked', this._onSend.bind(this));
        header.pack_end(this._sendButton);

        this.infobar = new Adw.Banner({title: _('Device is disconnected')});
        toolbar.add_top_bar(this.infobar);

        // Content
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
        });
        toolbar.set_content(this.stack);

        const editor = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        this.stack.add_named(editor, 'message-editor');

        this.entry = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 6,
            bottom_margin: 6,
            left_margin: 6,
            right_margin: 6,
        });
        const scrolled = new Gtk.ScrolledWindow({
            child: this.entry,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        scrolled.add_css_class('card');
        editor.append(scrolled);

        this.message_box = new Gtk.Box({
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            visible: false,
        });
        editor.append(this.message_box);

        this.message_avatar = new Contacts.Avatar();
        this.message_avatar.valign = Gtk.Align.START;
        this.message_box.append(this.message_avatar);

        this.message_label = new Gtk.Label({
            hexpand: true,
            use_markup: true,
            valign: Gtk.Align.CENTER,
            wrap: true,
            xalign: 0,
        });
        this.message_label.add_css_class('message-in');
        this.message_label.connect('activate-link', this._onActivateLink.bind(this));
        this.message_box.append(this.message_label);
    }

    _onCloseRequest() {
        this.saveGeometry();

        if (this._numberSelectedId !== undefined) {
            this.contact_chooser.disconnect(this._numberSelectedId);
            this.contact_chooser.cleanup();
        }

        this.entry.buffer.disconnect(this._entryChangedId);
        this.device.disconnect(this._connectedId);

        return false;
    }

    _onSend() {
        // Refuse to send empty or whitespace only texts
        if (!this.entry.buffer.text.trim())
            return;

        this.plugin.sendMessage(
            this.addresses,
            this.entry.buffer.text,
            1,
            true
        );

        this.close();
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
        Gtk.show_uri(
            this,
            uri.includes('://') ? uri : `https://${uri}`,
            Gdk.CURRENT_TIME
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
        this._sendButton.sensitive = this.device.connected &&
            !!this.entry.buffer.text.trim() &&
            this.stack.visible_child_name === 'message-editor';
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
