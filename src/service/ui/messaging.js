// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';

import * as Contacts from './contacts.js';
import * as Sms from '../plugins/sms.js';
import * as URI from '../utils/uri.js';
import '../utils/ui.js';

const Tweener = imports.tweener.tweener;


/*
 * Useful time constants
 */
const TIME_SPAN_MINUTE = 60000;
const TIME_SPAN_HOUR = 3600000;
const TIME_SPAN_DAY = 86400000;
const TIME_SPAN_WEEK = 604800000;
const LOADING_TIMEOUT_SECS = 1;


// Less than an hour (eg. 42 minutes ago)
const _lthLong = new Intl.RelativeTimeFormat('default', {
    numeric: 'auto',
    style: 'long',
});

// Less than a day ago (eg. 11:42 PM)
const _ltdFormat = new Intl.DateTimeFormat('default', {
    hour: 'numeric',
    minute: 'numeric',
});

// Less than a week ago (eg. Monday)
const _ltwLong = new Intl.DateTimeFormat('default', {
    weekday: 'long',
});

// Less than a week ago (eg. Mon)
const _ltwShort = new Intl.DateTimeFormat('default', {
    weekday: 'short',
});

// Less than a year (eg. Oct 31)
const _ltyShort = new Intl.DateTimeFormat('default', {
    day: 'numeric',
    month: 'short',
});

// Less than a year (eg. October 31)
const _ltyLong = new Intl.DateTimeFormat('default', {
    day: 'numeric',
    month: 'long',
});

// Greater than a year (eg. October 31, 2019)
const _gtyLong = new Intl.DateTimeFormat('default', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
});

// Greater than a year (eg. 10/31/2019)
const _gtyShort = new Intl.DateTimeFormat('default', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
});

// Pretty close to strftime's %c
const _cFormat = new Intl.DateTimeFormat('default', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
});


/**
 * Return a human-readable timestamp, formatted for longer contexts.
 *
 * @param {number} time - Milliseconds since the epoch (local time)
 * @returns {string} A localized timestamp similar to what Android Messages uses
 */
function getTime(time) {
    const date = new Date(time);
    const now = new Date();
    const diff = now - time;

    // Super recent
    if (diff < TIME_SPAN_MINUTE)
        // TRANSLATORS: Less than a minute ago
        return _('Just now');

    // Under an hour (TODO: these labels aren't updated)
    if (diff < TIME_SPAN_HOUR)
        return _lthLong.format(-Math.floor(diff / TIME_SPAN_MINUTE), 'minute');

    // Yesterday, but less than 24 hours ago
    if (diff < TIME_SPAN_DAY && now.getDay() !== date.getDay())
        // TRANSLATORS: Yesterday, but less than 24 hours (eg. Yesterday · 11:29 PM)
        return _('Yesterday・%s').format(_ltdFormat.format(time));

    // Less than a day ago
    if (diff < TIME_SPAN_DAY)
        return _ltdFormat.format(time);

    // Less than a week ago
    if (diff < TIME_SPAN_WEEK)
        return _ltwLong.format(time);

    // Sometime this year
    if (date.getFullYear() === now.getFullYear())
        return _ltyLong.format(time);

    // Earlier than that
    return _gtyLong.format(time);
}


/**
 * Return a human-readable timestamp, formatted for shorter contexts.
 *
 * @param {number} time - Milliseconds since the epoch (local time)
 * @returns {string} A localized timestamp similar to what Android Messages uses
 */
function getShortTime(time) {
    const date = new Date(time);
    const now = new Date();
    const diff = now - time;

    if (diff < TIME_SPAN_MINUTE)
        // TRANSLATORS: Less than a minute ago
        return _('Just now');

    if (diff < TIME_SPAN_HOUR) {
        // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
        return ngettext(
            '%d minute',
            '%d minutes',
            (diff / TIME_SPAN_MINUTE)
        ).format(diff / TIME_SPAN_MINUTE);
    }

    // Less than a day ago
    if (diff < TIME_SPAN_DAY)
        return _ltdFormat.format(time);

    // Less than a week ago
    if (diff < TIME_SPAN_WEEK)
        return _ltwShort.format(time);

    // Sometime this year
    if (date.getFullYear() === now.getFullYear())
        return _ltyShort.format(time);

    // Earlier than that
    return _gtyShort.format(time);
}


/**
 * Return a human-readable timestamp, similar to `strftime()` with `%c`.
 *
 * @param {number} time - Milliseconds since the epoch (local time)
 * @returns {string} A localized timestamp
 */
function getDetailedTime(time) {
    return _cFormat.format(time);
}


/**
 * Make the avatar for an incoming message visible or invisible
 *
 * @param {ConversationMessage} row - The message row to modify
 * @param {boolean} visible - Whether the avatar should be visible
 */
function setAvatarVisible(row, visible) {
    const incoming = row.message.type === Sms.MessageBox.INBOX;

    // Adjust the margins
    if (visible) {
        row.grid.margin_start = incoming ? 6 : 56;
        row.grid.margin_bottom = 6;
    } else {
        row.grid.margin_start = incoming ? 44 : 56;
        row.grid.margin_bottom = 0;
    }

    // Show hide the avatar
    if (incoming)
        row.avatar.set_visible(visible);
}

function formatPhoneNumber(phone) {
    phone = phone.replace(/^\+39/, '');
    phone = phone.replace(/[-\s]/g, '');
    return phone;
  }
  

/**
 * A ListBoxRow for each message of a conversation
 */
const ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationMessage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-message.ui',
    Children: ['grid', 'message-label', 'time-label'],
}, class ConversationMessage extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init();

        this.contact = contact;
        this.message = message;
        
        const has_attachments = (message['attachments'] !== undefined);

        const empty_placeholder = _('<i>(Empty or unsupported)</i>');

        // Set
        if (message.body) {
            this.message_label.label = URI.linkify(message.body);
        } else if (has_attachments) {
            this.message_label.label = '';
        } else {
            this.message_label.body = empty_placeholder;
        }
        this.message_label.tooltip_text = getDetailedTime(message.date);

        // Add avatar for incoming messages
        if (message.type === Sms.MessageBox.INBOX) {
            this.grid.margin_end = 18;
            this.grid.halign = Gtk.Align.START;
            
            this.message_label.get_style_context().add_class('message-in');
            this.message_label.halign = Gtk.Align.START;
        } else {
            this.message_label.get_style_context().add_class('message-out');
            this.time_label.halign = Gtk.Align.END;
        }        
        this.time_label.set_label(getShortTime(message.date));

    }

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    get date() {
        return this._message.date;
    }

    get thread_id() {
        return this._message.thread_id;
    }

    get message() {
        if (this._message === undefined)
            this._message = null;

        return this._message;
    }

    set message(message) {
        this._message = message;
    }

    _add_thumb(base64_image) {
        try {
            const [image_bytes, _len] = GLib.base64_decode(base64_image);

            const loader = GtkPixbuf.PixbufLoader();
            loader.write(image_bytes);
            loader.close();
        } catch (e) {
            logError(e);
            return;
        }

        const pixbuf = loader.get_pixbuf();
        const widget = Gtk.Image.new_from_pixbuf(pixbuf);
        this.attachment_box.add(widget);
    }
});

/**
 * A widget for displaying a conversation thread, with an entry for responding.
 */
const ConversationPartecipants = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationPartecipants',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this conversation',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'addresses': GObject.ParamSpec.object(
            'addresses',
            'Addresses',
            'The contact addresses',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-partecipants.ui',
    Children: [
        'contacts-list'
    ],
}, class MessagingConversationPartecipants extends Adw.Dialog {

    _init(params) {
        super._init();
        Object.assign(this, params);
        
        this.addresses.forEach(item => {
            const contact = this.device.contacts.query({number: item.address});
            const row = new Adw.ActionRow({
                title: contact.name,
                subtitle: Contacts.getDisplayNumber(contact, item.address),
            })
            row.add_prefix(new Adw.Avatar({
                text: contact.name,
                size: 40,
            }))
            this.contacts_list.append(row);
        });
    }

});

/**
 * A widget for displaying a conversation thread, with an entry for responding.
 */
const Conversation = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversation',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this conversation',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing this conversation',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'addresses': GObject.ParamSpec.object(
            'addresses',
            'Addresses',
            'The contact addresses',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'has-pending': GObject.ParamSpec.boolean(
            'has-pending',
            'Has Pending',
            'Whether there are sent messages pending confirmation',
            GObject.ParamFlags.READABLE,
            false
        ),
        'is-loading': GObject.ParamSpec.boolean(
            'is-loading',
            'Is Loading',
            'Whether the list is awaiting additional conversation history',
            GObject.ParamFlags.READABLE,
            false
        ),
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation.ui',
    Children: [
        'entry', 'list', 'scrolled',
        'pending', 'pending-box', 'avatar',
        'content-title', 'spinner', 'spinner-anim',
        'partecipants-button'
    ],
}, class MessagingConversation extends Adw.NavigationPage {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );


        this.inbox_counter = 0;

        const address = this.addresses[0].address;
        const contact = this.device.contacts.query({number: address});

        this.partecipants_button.connect('clicked', () => {
            if (this._partecipants_dialog === undefined)
            this._partecipants_dialog = new ConversationPartecipants({
                device: this.device,
                addresses: this.addresses,
            });
            this._partecipants_dialog.present(Gio.Application.get_default().get_active_window());
        });

        if (this.addresses.length === 1) {
            this.content_title.set_title(contact.name);
            this.content_title.set_subtitle(Contacts.getDisplayNumber(contact, address));
            this.avatar.set_text(contact.name);
        } else {
            const otherLength = this.addresses.length - 1;
            this.content_title.set_title(contact.name);
            this.content_title.set_subtitle(ngettext(
                'And %d other contact',
                'And %d others',
                otherLength
            ).format(otherLength));
        }

        //this.addMessage(this.message);
    
        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );
        this._ids = new Set();

        // Pending messages
        this.pending.message = {
            date: Number.MAX_SAFE_INTEGER,
            type: Sms.MessageBox.OUTBOX,
        };

        this.pending_messages = [];

        // Auto-scrolling
        this._vadj = this.scrolled.get_vadjustment();
        this._scrolledId = this._vadj.connect(
            'value-changed',
            this._holdPosition.bind(this)
        );

        // Message List
        this.internal_message_list = [];
        this.list.set_header_func(this._headerMessages);
        this.list.set_sort_func(this._sortMessages);
        this._populateMessages();

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    get addresses() {
        if (this._addresses === undefined)
            this._addresses = [];

        return this._addresses;
    }

    set addresses(addresses) {
        if (!addresses || addresses.length === 0) {
            this._addresses = [];
            this._contacts = {};
            return;
        }

        // Lookup a contact for each address object, then loop back to correct
        // each address carried by the message.
        this._addresses = addresses.filter((elemento, indice, self) => { return self.indexOf(elemento) === indice; });

        for (let i = 0, len = this.addresses.length; i < len; i++) {
            // Lookup the contact
            const address = this.addresses[i].address;
            const contact = this.device.contacts.query({number: address});

            // Get corrected address
            let number = address.toPhoneNumber();

            if (!number)
                continue;

            for (const contactNumber of contact.numbers) {
                const cnumber = contactNumber.value.toPhoneNumber();

                if (cnumber && (number.endsWith(cnumber) || cnumber.endsWith(number))) {
                    number = contactNumber.value;
                    break;
                }
            }

            // Store the final result
            this.addresses[i].address = number;
            this.contacts[address] = contact;
        }

        // TODO: Mark the entry as insensitive for group messages
        if (this.addresses.length > 1) {
            this.entry.placeholder_text = _('Not available');
            this.entry.secondary_icon_name = null;
            this.entry.secondary_icon_tooltip_text = null;
            this.entry.sensitive = false;
            this.entry.tooltip_text = null;
        }
    }

    get contacts() {
        if (this._contacts === undefined)
            this._contacts = {};

        return this._contacts;
    }

    get has_pending() {
        if (this.pending_messages === undefined)
            return false;

        return (this.pending_messages.length > 0);
    }

    get is_loading() {
        if (this._loading === undefined)
            this._loading = false;
        return this._loading;
    }

    set is_loading(value) {
        this._loading = value;
    }

    get next_request() {
        if (this.earliest_requested == this.earliest)
            return -2;
        return Math.min(this.earliest_requested, this.earliest);
    }

    get earliest_requested() {
        if (this._earliestRequested === undefined)
            this._earliestRequested = Number.MAX_SAFE_INTEGER;
        return this._earliestRequested;
    }

    set earliest_requested(requested) {
        this._earliestRequested = requested;
    }

    get earliest() {
        if (this._earliest === undefined)
            this._earliest = -1;
        return this._earliest;
    }

    set earliest(new_earliest) {
        this._earliest = new_earliest;
    }

    get latest() {
        if (this._latest === undefined)
            this._latest = -1;
        return this._latest;
    }

    set latest(new_latest) {
        this._latest = new_latest;
    }

    get windowFilled() {
        const upper = this._vadj.get_upper();
        const pageSize = this._vadj.get_page_size();

        // Has the scrolled window been filled yet?
        return !(upper <= pageSize);
    }

    get plugin() {
        if (this._plugin === undefined)
            this._plugin = null;

        return this._plugin;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        if (this._thread_id === undefined)
            this._thread_id = null;

        return this._thread_id;
    }

    set thread_id(thread_id) {
        const message = this.plugin.getThreadLatestMessage(thread_id);

        if (message && this.addresses.length === 0) {
            this.addresses = message.addresses;
            this._thread_id = thread_id;
        }
    }

    _onConnected(device) {
        if (device.connected)
            this.pending_messages.forEach(row =>  {
                this.pending_box.remove(row);
                row.run_dispose()
            });
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation._vadj.disconnect(conversation._scrolledId);

        conversation.internal_message_list.forEach(message => {
            conversation.list.remove(message);
            message.run_dispose();
        });

        conversation.internal_message_list = [];
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onKeyPressEvent(entry, event) {
        const keyval = event.get_keyval()[1];
        const state = event.get_state()[1];
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Return && (mask & Gdk.ModifierType.SHIFT_MASK)) {
            entry.emit('insert-at-cursor', '\n');
            return true;
        }

        return false;
    }

    _onSendMessage(entry, signal_id, event) {
        // Don't send empty texts
        if (!this.entry.text.trim())
            return;

        // Send the message
        this.plugin.sendMessage(this.addresses, this.entry.text);

        // Add a phony message in the pending box
        const message = new Gtk.Label({
            label: URI.linkify(this.entry.text),
            halign: Gtk.Align.END,
            selectable: true,
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0,
        });
        message.get_style_context().add_class('message-out');
        message.date = Date.now();
        message.type = Sms.MessageBox.SENT;

        // Notify to reveal the pending box
        this.pending_messages.push(message);
        this.pending_box.append(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const animation = this._createScrollbarAnim(1);
            animation.play();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createScrollbarAnim(direction) {
        const adjustment = this.scrolled.get_vadjustment();;
        const target = Adw.PropertyAnimationTarget.new(adjustment, "value");
        const animation = new Adw.TimedAnimation({
          widget: this.scrolled,
          value_from: adjustment.value,
          value_to: direction ? adjustment.upper - adjustment.page_size : 0,
          duration: 250,
          easing: Adw.Easing["LINEAR"],
          target: target,
        });
        return animation;
    }

    /**
     * Create a message row, ensuring a contact object has been retrieved or
     * generated for the message.
     *
     * @param {object} message - A dictionary of message data
     * @returns {ConversationMessage} A message row
     */
    _createMessageRow(message) {
        // Ensure we have a contact
        const sender = message.addresses[0].address || 'unknown';

        if (this.contacts[sender] === undefined) {
            this.contacts[sender] = this.device.contacts.query({
                number: sender,
            });
        }

        return new ConversationMessage(this.contacts[sender], message);
    }

    _populateMessages() {
        this.earliest = Number.MAX_SAFE_INTEGER;
        this.latest = -1;
        this.earliest_requested = -1;
        this._ids.clear();
        this.__pos = 0;
        this._stop_loading_spinner();

        // Try and find a thread_id for this number
        if (this.thread_id === null && this.addresses.length)
            this._thread_id = this.plugin.getThreadIdForAddresses(this.addresses);

        // Fill the window with messages from the thread
        if (!this.windowFilled) {
            this._requestMore();
        }
    }

    _requestMore() {
        this.plugin.requestMore(this.thread_id, this.earliest);
        this.earliest_requested = this.earliest;
        this._start_loading_spinner();
    }

    _start_loading_spinner() {
        this.spinner_anim.active = true;
        this.spinner.visible = true;
        if (this._spinnerTimeoutID && this._spinnerTimeoutID > 0) {
            this._spinnerTimeoutID.destroy();
        }
        this._spinnerTimeoutID = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            LOADING_TIMEOUT_SECS,
            this._onSpinnerTimeoutExpired.bind(this)
        );
    }

    _onSpinnerTimeoutExpired() {
        this._hide_spinner();
        const adj = this.scrolled.get_vadjustment();
        adj.set_value(adj.get_upper() - adj.get_page_size());
        return GLib.SOURCE_REMOVE;
    }

    /**
     * Disable the loading spinner and/or expiration timer, if running
     */
    _stop_loading_spinner() {
        this._hide_spinner();
        if (this._spinnerTimeoutID === undefined || !this._spinnerTimeoutID) {
            this._spinnerTimeoutID = 0;
        }
    }

    _hide_spinner() {
        this.spinner_anim.active = false;
        this.spinner.visible = false;
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending')
            return;

        // Add date header if the last message was more than an hour ago
        let header = row.get_header();

        if (before != null && before.message != undefined && (row.message.date - before.message.date) > TIME_SPAN_HOUR) {
            if (!header) {
                header = new Gtk.Label({visible: true, selectable: true});
                header.get_style_context().add_class('dim-label');
                row.set_header(header);
            }

            header.label = getTime(row.message.date);

        }
    }

    _holdPosition() {
        this.__pos = this._vadj.get_upper() - this._vadj.get_value();
    }

    _releasePosition() {
        this.__pos = 0;
    }

    _sortMessages(row1, row2) {
        if (row1.message === undefined)
            return -1;
        else 
            return (row1.message.date > row2.message.date) ? 1 : -1;
    }

    /**
     * Add a message to the conversation.
     *
     * @param {object} message - A message object
     */
    addMessage(message) {
        try {
            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                throw TypeError(`invalid message box ${message.type}`);

            // Skip already-shown messages
            if (this._ids.has(message._id))
                return;
            this._ids.add(message._id);

            const row = this._createMessageRow(message);
            
            // Insert the message in its sorted location
            this.list.append(row);
            this.internal_message_list.push(row);

            if (message.read === Sms.MessageStatus.UNREAD) {
                this.inbox_counter += 1;
            }

            if (message.date > this.latest) {
                this.latest = message.date;
                // Remove the first pending message
                if (this.has_pending && message.type === Sms.MessageBox.SENT) {
                    this.pending_messages.forEach(pending_row => {
                        this.pending_box.remove(pending_row);
                    })
                    this.pending_messages = [];
                    this.notify('has-pending');
                } 
               
            } 

            if (message.date < this.earliest || this.earliest < 0) {
                this.earliest = message.date;
            }
            
            if (message.date < this.earliest_requested && this.is_loading) {
                this._end_loading_spinner();
            }
            
            this.list.invalidate_headers();
        } catch (e) {
            debug(e);
        }
    }

    _onEmojiPicked(widget, emoticon) {
        const text = this.entry.get_text();
        this.entry.set_text(text + emoticon);
    }

    /**
     * Set the contents of the message entry
     *
     * @param {string} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.emit('move-cursor', 0, text.length, false);
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
const ConversationSummary = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationSummary',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-summary.ui',
    Children: ['avatar', 'time-label', 'counter-label'],
}, class ConversationSummary extends Adw.ActionRow {
    _init(contacts, message) {
        super._init();

        this.contacts = contacts;
        this.message = message;
    }

    get date() {
        return this._message.date;
    }

    get thread_id() {
        return this._message.thread_id;
    }

    get message() {
        return this._message;
    }

    set message(message) {
        this._message = message;

        const addresses = message.addresses.map(item => item.address).filter((elemento, indice, self) => self.indexOf(elemento) === indice);
        this._sender = addresses[0] || 'unknown';

        // TRANSLATORS: Shown as the summary when a text message contains
        // only image content (no text body)
        const image_placeholder = _('<i>image</i>');

        // Contact Name
        let name_label = _('Unknown Contact');

        const sent = message.type === Sms.MessageBox.SENT;
        const unread = message.read === Sms.MessageStatus.UNREAD;
        
        const has_attachments = message['attachments'] !== undefined;

        // Update avatar for single-recipient messages
        if (addresses.length === 1) {
            let contact = this.contacts[this._sender];
            if (contact) {
                this.avatar.set_text(contact.name);
                name_label = GLib.markup_escape_text(contact.name, -1);
            } else {
                this.avatar.set_text(this._sender);
                name_label = GLib.markup_escape_text(this._sender, -1);
            }
        } else {
            name_label = _('Group Message');
            this.avatar.icon_name = 'system-users-symbolic';
            const participants = [];
            addresses.forEach(address => {
                participants.push(this.contacts[address].name);
            });
            //this.name_label.tooltip_text = participants.join(', ');
        }

        // Contact Name & Message body
        let body_label = '';
        if (message.body == undefined) {
            body_label = _('New conversation')
            this.time_label.set_visible(false);
        } else if (message.body.length) {
            body_label = message.body.split(/\r|\n/)[0];
            body_label = GLib.markup_escape_text(body_label, -1);

            if (sent) {
                // TRANSLATORS: An outgoing message body in a conversation summary
                body_label = _('You: %s').format(body_label);
            }
            this.time_label.set_visible(true);
        } else if (has_attachments) {
            body_label = image_placeholder;
            this.time_label.set_visible(true);
        } 

        // Make it bold if it's unread
        if (unread) {
            name_label = `<b>${name_label}</b>`;
            body_label = `<b>${body_label}</b>`;
            this.counter_label.set_visible(true);
        }                    

        // Set the labels, body always smaller
        this.set_title(name_label);
        this.set_subtitle(`<small>${body_label}</small>`);

        // Time
        this.time_label.set_label(`<small>${getShortTime(message.date)}</small>`);
    }

    /**
     * Update the relative time label.
     */
    update() {
        this.time_label.set_label(`<small>${getShortTime(this.message.date)}</small>`);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
export const Window = GObject.registerClass({
    GTypeName: 'GSConnectMessagingWindow',
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
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-window.ui',
    Children: [
        'sidebar-title', 'split-view',
        'thread-list', 'toast-overlay'
    ],
}, class MessagingWindow extends Adw.ApplicationWindow {

    _init(params) {
        super._init(params);
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        // Aggiungi il tuo prefisso GResource in cui hai messo le SVG
        iconTheme.add_resource_path(
            '/org/gnome/Shell/Extensions/GSConnect/icons'
        );
        this.stack = new Map();
        
        this.sidebar_title.set_subtitle(this.device.name);
        this.insert_action_group('device', this.device);

        // Device Status
        
        this.device.connect('notify::connected', (device) => {
            if(!device.connected) {
                const toast = new Adw.Toast({
                    title: _("Device is disconnected"),
                    timeout: 5,
                });
                this.toast_overlay.add_toast(toast);
            }
        });

        // Contacts
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device,
        })

        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Threads
        this.internal_thread_list = [];
        this.thread_list.set_sort_func(this._sortThreads);

        this._threadsChangedId = this.plugin.connect(
            'notify::threads',
            this._onThreadsChanged.bind(this)
        );

        this._timestampThreadsId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            60,
            this._timestampThreads.bind(this)
        );

        this._sync();
        this._onThreadsChanged();
        this.restoreGeometry('messaging');
    }

    vfunc_close_request(event) {
        this.saveGeometry();

        GLib.source_remove(this._timestampThreadsId);
        this.contact_chooser.disconnect(this._numberSelectedId);
        this.plugin.disconnect(this._threadsChangedId);

        this.destroy();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        return this.split_view.content.thread_id;
    }

    set thread_id(thread_id) {
        thread_id = `${thread_id}`; // FIXME

        // Reset to the empty placeholder
        if (!thread_id) {
            this.thread_list.select_row(null);
            return;
        }

        // Create a conversation widget if there isn't one
        let conversation = this.stack.get(thread_id);
        const message = this.plugin.getThreadLatestMessage(thread_id);

        if (conversation === undefined) {
            if (!message) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new Conversation({
                device: this.device,
                plugin: this.plugin,
                addresses: message.addresses,
                thread_id: thread_id,
            });
            
            this.stack.set(thread_id, conversation);
        }


        // Select the conversation and entry active
        this.split_view.set_content(conversation);
        this.split_view.set_show_content(true);

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread_id');
    }
    _sync() {
        this.device.contacts.fetch();
        this.plugin.connected();
    }

    _onNewConversation() {
        this._sync();
        this.split_view.set_content(this.contact_chooser);
        this.split_view.set_show_content(true);
        this.thread_list.select_row(null);
    }

    _onNumberSelected(chooser, number) {
        const contacts = chooser.getSelected();
        let row = this._getRowForContacts(contacts);

        if (row) {
            row.emit('activated');
            this._onThreadSelected(null, row);
        }
        else {
            const message = {
                addresses: [
                  { address: number },
                ],
                type: Sms.MessageBox.SENT,
                read: Sms.MessageStatus.READ,
                attachments: [], 
                date: new Date(),
            };
            const contacts = this.device.contacts.lookupAddresses(message.addresses);
            row = new ConversationSummary(contacts, message);
            this.internal_thread_list.push(row);
            this.thread_list.prepend(row);
            this.setContacts(contacts);
        }
    }

    /**
     * Threads
     */
    _onThreadsChanged() {
        // Get the last message in each thread
        const messages = this.plugin.getLatestMessagePerThread();

        for (const [thread_id, message] of Object.entries(messages)) {
            if (message.addresses === undefined)
                throw TypeError(`Missing addresses for ${thread_id}!`)
            this.logMessage(message);
        }

    }

    // GtkListBox::row-activated
    _onThreadSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.thread_id = row.thread_id;
        } 
    }

    _sortThreads(row1, row2) {
        return (row1.date > row2.date) ? -1 : 1;
    }

    _timestampThreads() {
        if (this.visible)
            this.internal_thread_list.forEach(row => row.update());

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for @contacts
     *
     * @param {object[]} contacts - A contact group
     * @returns {ConversationSummary|null} The thread row or %null
     */
    _getRowForContacts(contacts) {
        const addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });

        // Try to find a thread_id
        const thread_id = this.plugin.getThreadIdForAddresses(addresses);

        return this._getRowForThread(thread_id);
    }

    _getRowForThread(thread_id) {
        let result_row = null
        this.internal_thread_list.forEach(row => {
            if (row.thread_id === thread_id)
                result_row = row;
        });
        return result_row;
    }

    setContacts(contacts) {
        // Group the addresses
        const addresses = [];

        for (const address of Object.keys(contacts))
            addresses.push({address: address});

        // Try to find a thread ID for this address group
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        if (thread_id === null)
            thread_id = GLib.uuid_string_random();
        else
            thread_id = thread_id.toString();

        // Try to find a thread row for the ID
        const row = this._getRowForContacts(contacts);

        if (row !== null) {
            this.thread_list.select_row(row);
            return;
        }

        // We're creating a nloew conversation
        const conversation = new Conversation({
            device: this.device,
            plugin: this.plugin,
            addresses: addresses,
        });

        // Select the conversation and entry active
        this.stack.set(thread_id, conversation);

        this.split_view.set_content(conversation);
        this.split_view.set_show_content(true);
        
        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread-id');
    }

    _includesAddress(addresses, addressObj) {
        const number = addressObj.address.toPhoneNumber();

        for (const haystackObj of addresses) {
            const tnumber = haystackObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number))
                return true;
        }

        return false;
    }


    logMessage(message) {
        const thread_id = message.thread_id;
        const timestamp = message.date;
        let addresses = message.addresses;
        // Update existing summary or create new one
        let row = this._getRowForThread(thread_id);
        // If it's a newer message for an existing conversation, update it
        if (row) {
            if (row.date < timestamp) {
                // Ensure there's a contact mapping
                const sender = addresses[0] || 'unknown';
                
                if (row.contacts[sender.address] === undefined) {
                    row.contacts[sender.address] = this.device.contacts.query({
                        number: sender,
                    });
                }

                row.message = message;
                // Re-sort the summaries
                this.thread_list.invalidate_sort();
            }
        } 
        addresses = addresses.map(item => formatPhoneNumber(item.address)).filter((item, index, self) => {return self.indexOf(item) === index;});
        if (row === null) {
            let need_row_init = true;
            this.internal_thread_list.forEach(row_item => {
                if (Object.keys(row_item.contacts).map(item => formatPhoneNumber(item)).every(item => addresses.includes(item))) {
                    row_item.message = message;
                    this.thread_list.invalidate_sort();
                    need_row_init = false;
                }
                
            });
            if (need_row_init) {
                const contacts = this.device.contacts.lookupAddresses(message.addresses);
                row = new ConversationSummary(contacts, message);
                row.counter_label.set_label("1");
                this.internal_thread_list.push(row);
                this.thread_list.append(row);
            }
        }
        // If it's a message for the selected conversation, display it
        if (thread_id === this.thread_id) {
            const conversation = this.stack.get(`${thread_id}`);
            conversation.addMessage(message);
            row.counter_label.set_label(`${conversation.inbox_counter}`);
        } else {
            Array.from(this.stack.values()).forEach(conversation => {
                const contacts = conversation.addresses.map(item => formatPhoneNumber(item.address)).filter((item, index, self) => {
                    return self.indexOf(item) === index && addresses.includes(item);
                });
                if (contacts.length > 0) {
                    conversation.thread_id = thread_id;
                    conversation.addMessage(message);
                }
            });
        }
    }

    /**
     * Try and find an existing conversation widget for @message.
     *
     * @param {object} message - A message object
     * @returns {Conversation|null} A conversation widget or %null
     */
    getConversationForMessage(message) {
        // TODO: This shouldn't happen?
        if (message === null)
            return null;

        // First try to find a conversation by thread_id
        const thread_id = `${message.thread_id}`;
        const conversation = this.stack.get(thread_id);
        const old_thread_id = null;

        if (conversation == null) {
            // Try and find one by matching addresses, which is necessary if we've
            // started a thread locally and haven't set the thread_id
            const addresses = message.addresses;

            for (const conversation of this.stack.values()) {
                if (conversation.addresses === undefined ||
                    conversation.addresses.length !== addresses.length)
                    continue;

                const caddrs = conversation.addresses;

                // If we find a match, set `thread-id` on the conversation and the
                // child property `name`.
                if (addresses.every(addr => this._includesAddress(caddrs, addr))) {
                    old_thread_id = conversation._thread_id;
                    conversation._thread_id = thread_id;
                }
            }
        }
        this.stack.delete(old_thread_id);
        this.stack.set(thread_id, conversation);

        return conversation;
    }

    /**
     * Set the contents of the message entry. If @pending is %false set the
     * message of the currently selected conversation, otherwise mark the
     * message to be set for the next selected conversation.
     *
     * @param {string} message - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    sendMessage(message, pending = false) {
        try {
            if (pending)
                this._pendingShare = message;
            else
                this.stack.get(this.thread_id).setMessage(message);
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * A Gtk.ApplicationWindow for selecting from open conversations
 */
export const ConversationChooser = GObject.registerClass({
    GTypeName: 'GSConnectConversationChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'message': GObject.ParamSpec.string(
            'message',
            'Message',
            'The message to share',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-message.ui',
    Children: ['thread_list'],
}, class ConversationChooser extends Adw.ApplicationWindow {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.thread_list.set_sort_func(Window.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.thread_list);

        // Filter Setup
        Window.prototype._onThreadsChanged.call(this);
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _new(button) {
        this.close();
        this.plugin.sms();
        this.plugin.window._onNewConversation();
        this.plugin.window._pendingShare = message;
    }

    _select(box, row) {
        const message = this.message;
        const thread_id = row.message.thread_id.toString();
        this.close();
        this.plugin.sms();
        this.plugin.window.thread_id = thread_id;
        this.plugin.window.setMessage(message);
    }
});
