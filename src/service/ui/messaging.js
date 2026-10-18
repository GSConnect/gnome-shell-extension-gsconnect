// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import * as Contacts from './contacts.js';
import * as Sms from '../plugins/sms.js';
import * as URI from '../utils/uri.js';
import {children} from '../utils/ui.js';

const Tweener = imports.tweener.tweener;


/*
 * Useful time constants
 */
const TIME_SPAN_MINUTE = 60000;
const TIME_SPAN_HOUR = 3600000;
const TIME_SPAN_DAY = 86400000;
const TIME_SPAN_WEEK = 604800000;


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
 * Open a link from a message label
 *
 * @param {Gtk.Widget} widget - The widget that emitted `activate-link`
 * @param {string} uri - The URI or bare address
 * @returns {boolean} %true, to stop other handlers
 */
function activateLink(widget, uri) {
    Gtk.show_uri(
        widget.get_root(),
        uri.includes('://') ? uri : `https://${uri}`,
        Gdk.CURRENT_TIME
    );

    return true;
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
        row.avatar.visible = visible;
}


/**
 * Get the pages of a Gtk.Stack
 *
 * @param {Gtk.Stack} stack - A stack
 * @returns {Gtk.Widget[]} The children of the stack
 */
function stackChildren(stack) {
    const pages = stack.get_pages();
    const result = [];

    for (let i = 0, len = pages.get_n_items(); i < len; i++)
        result.push(pages.get_item(i).child);

    return result;
}


/**
 * A ListBoxRow for a preview of a conversation
 */
const ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationMessage',
}, class ConversationMessage extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init({hexpand: true});

        this.grid = new Gtk.Grid({
            halign: Gtk.Align.END,
            hexpand: true,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
            column_spacing: 6,
        });
        this.grid.add_css_class('message-row');
        this.set_child(this.grid);

        this.avatar = new Contacts.Avatar();
        this.avatar.valign = Gtk.Align.END;
        this.avatar.visible = false;
        this.grid.attach(this.avatar, 0, 1, 1, 1);

        this.sender_label = new Gtk.Label({
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            margin_start: 6,
            visible: false,
        });
        this.grid.attach(this.sender_label, 1, 0, 1, 1);

        this.message_label = new Gtk.Label({
            halign: Gtk.Align.END,
            use_markup: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            max_width_chars: 48,
            selectable: true,
            xalign: 0,
        });
        this.message_label.connect('activate-link', activateLink);
        this.grid.attach(this.message_label, 1, 1, 1, 1);

        this.contact = contact;
        this.message = message;

        // Sort properties
        this.sender = message.addresses[0].address || 'unknown';
        this.message_label.label = URI.linkify(message.body);
        this.message_label.tooltip_text = getDetailedTime(message.date);

        // Add avatar for incoming messages
        if (message.type === Sms.MessageBox.INBOX) {
            this.grid.margin_end = 18;
            this.grid.halign = Gtk.Align.START;

            this.avatar.contact = this.contact;
            this.avatar.visible = true;

            this.sender_label.label = contact.name;
            this.sender_label.visible = true;

            this.message_label.add_css_class('message-in');
            this.message_label.halign = Gtk.Align.START;
        } else {
            this.message_label.add_css_class('message-out');
        }
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
        'has-pending': GObject.ParamSpec.boolean(
            'has-pending',
            'Has Pending',
            'Whether there are sent messages pending confirmation',
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
}, class MessagingConversation extends Gtk.Box {

    _init(params) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            device: params.device,
            plugin: params.plugin,
        });

        this._buildLayout();
        Object.assign(this, params);

        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );

        // Pending messages
        this.pending.message = {
            date: Number.MAX_SAFE_INTEGER,
            type: Sms.MessageBox.OUTBOX,
        };

        // Auto-scrolling
        this._vadj = this.scrolled.get_vadjustment();
        this._scrolledId = this._vadj.connect(
            'value-changed',
            this._holdPosition.bind(this)
        );
        this._upperId = this._vadj.connect(
            'notify::upper',
            this._onSizeChanged.bind(this)
        );
        this._pageSizeId = this._vadj.connect(
            'notify::page-size',
            this._onSizeChanged.bind(this)
        );

        // Message List
        this.list.set_header_func(this._headerMessages);
        this.list.set_sort_func(this._sortMessages);
        this._populateMessages();
    }

    _buildLayout() {
        this.list = new Gtk.ListBox({
            valign: Gtk.Align.END,
            selection_mode: Gtk.SelectionMode.NONE,
        });
        this.list.add_css_class('message-list');

        this.scrolled = new Gtk.ScrolledWindow({
            child: this.list,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        this.scrolled.add_css_class('message-scrolled');
        this.scrolled.connect('edge-reached', this._onEdgeReached.bind(this));
        this.append(this.scrolled);

        // Pending messages
        this.pending = new Gtk.ListBoxRow({
            hexpand: true,
            activatable: false,
            selectable: false,
        });
        this.pending.set_name('pending');
        this.pending.add_css_class('message-pending');
        this.pending_box = new Gtk.Box({
            halign: Gtk.Align.END,
            margin_top: 6,
            margin_bottom: 6,
            margin_end: 6,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
        });
        this.pending.set_child(this.pending_box);
        this.list.append(this.pending);

        // Entry
        this.entry = new Gtk.Entry({
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
            secondary_icon_name: 'mail-send-symbolic',
            secondary_icon_tooltip_text: _('Send Message'),
            secondary_icon_sensitive: false,
            placeholder_text: _('Type a message'),
        });
        this.entry.update_property([Gtk.AccessibleProperty.LABEL], [_('Message')]);
        this.entry.connect('activate', this._onSendMessage.bind(this));
        this.entry.connect('changed', this._onEntryChanged.bind(this));
        this.entry.connect('icon-release', this._onSendMessage.bind(this));

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', this._onKeyPressed.bind(this));
        this.entry.add_controller(keys);
        this.append(this.entry);
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
        this._addresses = addresses;

        for (let i = 0, len = this.addresses.length; i < len; i++) {
            // Lookup the contact
            const address = this.addresses[i].address;
            const contact = this.device.contacts.query({number: address});

            // Get corrected address
            let number = address.toPhoneNumber();

            if (!number)
                continue;

            for (const contactNumber of contact.numbers) {
                if (number.equalsPhoneNumber(contactNumber.value)) {
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
        if (this.pending_box === undefined)
            return false;

        return this.pending_box.get_first_child() !== null;
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
        const thread = this.plugin.threads[thread_id];
        const message = (thread) ? thread[0] : null;

        if (message && this.addresses.length === 0) {
            this.addresses = message.addresses;
            this._thread_id = thread_id;
        }
    }

    _onConnected(device) {
        if (device.connected) {
            for (const message of children(this.pending_box))
                this.pending_box.remove(message);

            this.notify('has-pending');
        }
    }

    /**
     * Release signal handlers and rows. Must be called before the
     * conversation is discarded.
     */
    cleanup() {
        if (this._connectedId === undefined)
            return;

        this.device.disconnect(this._connectedId);
        this._vadj.disconnect(this._scrolledId);
        this._vadj.disconnect(this._upperId);
        this._vadj.disconnect(this._pageSizeId);
        this._connectedId = undefined;

        for (const row of children(this.list))
            this.list.remove(row);
    }

    _onEdgeReached(scrolled_window, pos) {
        // Try to load more messages
        if (pos === Gtk.PositionType.TOP)
            this.logPrevious();

        // Release any hold to resume auto-scrolling
        else if (pos === Gtk.PositionType.BOTTOM)
            this._releasePosition();
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length > 0);
    }

    _onKeyPressed(controller, keyval, keycode, state) {
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Return && (mask & Gdk.ModifierType.SHIFT_MASK)) {
            this.entry.get_delegate().emit('insert-at-cursor', '\n');
            return Gdk.EVENT_STOP;
        }

        return Gdk.EVENT_PROPAGATE;
    }

    _onSendMessage() {
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
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            max_width_chars: 48,
            xalign: 0,
        });
        message.add_css_class('message-out');
        message.date = Date.now();
        message.type = Sms.MessageBox.SENT;

        // Notify to reveal the pending box
        this.pending_box.append(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';
    }

    /*
     * Replaces the GTK3 `size-allocate` handler: the content of the list
     * changed size, so either load more, hold the position or follow the end.
     */
    _onSizeChanged() {
        const upper = this._vadj.get_upper();
        const pageSize = this._vadj.get_page_size();

        // If the scrolled window hasn't been filled yet, load another message
        if (upper <= pageSize)
            this.logPrevious();

        // We've been asked to hold the position, so we'll reset the adjustment
        // value and update the hold position
        else if (this.__pos)
            this._vadj.set_value(upper - this.__pos);

        // Otherwise we probably appended a message and should scroll to it
        else
            this._scrollPosition(Gtk.PositionType.BOTTOM);
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
        this.__first = null;
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a thread_id for this number
        if (this.thread_id === null && this.addresses.length)
            this._thread_id = this.plugin.getThreadIdForAddresses(this.addresses);

        // Make a copy of the thread and fill the window with messages
        if (this.plugin.threads[this.thread_id]) {
            this.__messages = this.plugin.threads[this.thread_id].slice(0);
            this.logPrevious();
        }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending')
            return;

        if (before === null)
            return setAvatarVisible(row, true);

        // Add date header if the last message was more than an hour ago
        let header = row.get_header();

        if ((row.message.date - before.message.date) > TIME_SPAN_HOUR) {
            if (!header) {
                header = new Gtk.Label({selectable: true});
                header.add_css_class('dim-label');
                row.set_header(header);
            }

            header.label = getTime(row.message.date);

            // Also show the avatar
            setAvatarVisible(row, true);

            row.sender_label.visible = row.message.addresses.length > 1;

        // Or if the previous sender was the same, hide its avatar
        } else if (row.message.type === before.message.type &&
                   row.sender.equalsPhoneNumber(before.sender)) {
            setAvatarVisible(before, false);
            setAvatarVisible(row, true);

            row.sender_label.visible = false;

        // otherwise show the avatar
        } else {
            setAvatarVisible(row, true);
        }
    }

    _holdPosition() {
        this.__pos = this._vadj.get_upper() - this._vadj.get_value();
    }

    _releasePosition() {
        this.__pos = 0;
    }

    _scrollPosition(pos = Gtk.PositionType.BOTTOM, animate = true) {
        let vpos = pos;
        this._vadj.freeze_notify();

        if (pos === Gtk.PositionType.BOTTOM)
            vpos = this._vadj.get_upper() - this._vadj.get_page_size();

        if (animate) {
            Tweener.addTween(this._vadj, {
                value: vpos,
                time: 0.5,
                transition: 'easeInOutCubic',
                onComplete: () => this._vadj.thaw_notify(),
            });
        } else {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._vadj.set_value(vpos);
                this._vadj.thaw_notify();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _sortMessages(row1, row2) {
        return (row1.message.date > row2.message.date) ? 1 : -1;
    }

    /**
     * Log the next message in the conversation.
     *
     * @param {object} message - A message object
     */
    logNext(message) {
        try {
            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                throw TypeError(`invalid message box ${message.type}`);

            // Append the message
            const row = this._createMessageRow(message);
            this.list.append(row);
            this.list.invalidate_headers();

            // Remove the first pending message
            if (this.has_pending && message.type === Sms.MessageBox.SENT) {
                this.pending_box.remove(this.pending_box.get_first_child());
                this.notify('has-pending');
            }
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Log the previous message in the thread
     */
    logPrevious() {
        try {
            const message = this.__messages.pop();

            if (!message)
                return;

            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                throw TypeError(`invalid message box ${message.type}`);

            // Prepend the message
            const row = this._createMessageRow(message);
            this.list.prepend(row);
            this.list.invalidate_headers();
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Set the contents of the message entry
     *
     * @param {string} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.set_position(-1);
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
const ConversationSummary = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationSummary',
}, class ConversationSummary extends Gtk.ListBoxRow {
    _init(contacts, message) {
        super._init();

        const grid = new Gtk.Grid({
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 8,
            margin_end: 8,
            column_spacing: 8,
        });
        grid.add_css_class('conversation-row');
        this.set_child(grid);

        this.avatar = new Contacts.Avatar();
        this.avatar.margin_end = 4;
        grid.attach(this.avatar, 0, 0, 1, 2);

        this.name_label = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
        });
        grid.attach(this.name_label, 1, 0, 1, 1);

        this.time_label = new Gtk.Label({
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
        });
        this.time_label.add_css_class('dim-label');
        grid.attach(this.time_label, 2, 0, 1, 1);

        this.body_label = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
        });
        grid.attach(this.body_label, 1, 1, 2, 1);

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
        this._sender = message.addresses[0].address || 'unknown';

        // Contact Name
        let nameLabel = _('Unknown Contact');

        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this.avatar.contact = this.contacts[this._sender];
            nameLabel = GLib.markup_escape_text(this.contacts[this._sender].name, -1);
        } else {
            this.avatar.contact = null;
            nameLabel = _('Group Message');
            const participants = [];
            message.addresses.forEach((address) => {
                participants.push(this.contacts[address.address].name);
            });
            this.name_label.tooltip_text = participants.join(', ');
        }

        // Contact Name & Message body
        let bodyLabel = message.body.split(/\r|\n/)[0];
        bodyLabel = GLib.markup_escape_text(bodyLabel, -1);

        // Ignore the 'read' flag if it's an outgoing message
        if (message.type === Sms.MessageBox.SENT) {
            // TRANSLATORS: An outgoing message body in a conversation summary
            bodyLabel = _('You: %s').format(bodyLabel);

        // Otherwise make it bold if it's unread
        } else if (message.read === Sms.MessageStatus.UNREAD) {
            nameLabel = `<b>${nameLabel}</b>`;
            bodyLabel = `<b>${bodyLabel}</b>`;
        }

        // Set the labels, body always smaller
        this.name_label.label = nameLabel;
        this.body_label.label = `<small>${bodyLabel}</small>`;

        // Time
        const timeLabel = `<small>${getShortTime(message.date)}</small>`;
        this.time_label.label = timeLabel;
    }

    /**
     * Update the relative time label.
     */
    update() {
        const timeLabel = `<small>${getShortTime(this.message.date)}</small>`;
        this.time_label.label = timeLabel;
    }
});


/**
 * A placeholder with an icon, a title and an optional description
 *
 * @param {string} icon - An icon name
 * @param {number} size - The icon pixel size
 * @param {string} title - The title
 * @param {string} [description] - An optional description
 * @returns {Gtk.Box} A placeholder widget
 */
function createPlaceholder(icon, size, title, description = null) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        vexpand: true,
        hexpand: true,
        spacing: 6,
    });
    box.add_css_class('placeholder');

    const image = new Gtk.Image({icon_name: icon, pixel_size: size});
    image.add_css_class('placeholder-image');
    box.append(image);

    const titleLabel = new Gtk.Label({label: title});
    titleLabel.add_css_class('placeholder-title');
    box.append(titleLabel);

    if (description) {
        const descriptionLabel = new Gtk.Label({label: description});
        descriptionLabel.add_css_class('placeholder-description');
        box.append(descriptionLabel);
    }

    return box;
}


/**
 * An Adw.ApplicationWindow for SMS conversations
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
}, class MessagingWindow extends Adw.ApplicationWindow {

    _init(params) {
        super._init({
            application: params.application,
            default_width: 640,
            default_height: 480,
            icon_name: 'org.gnome.Shell.Extensions.GSConnect-symbolic',
            device: params.device,
            plugin: params.plugin,
        });

        this._buildLayout();
        this.headerbar.subtitle = this.device.name;

        this.insert_action_group('device', this.device);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'revealed',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Contacts
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device,
        });
        this.stack.add_named(this.contact_chooser, 'contact-chooser');

        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Threads
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

        this.connect('close-request', this._onCloseRequest.bind(this));
    }

    _buildLayout() {
        const split = new Adw.NavigationSplitView({
            min_sidebar_width: 220,
            max_sidebar_width: 320,
        });
        this.split_view = split;
        this.set_content(split);

        // Collapse to one pane on narrow windows
        const breakpoint = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 560sp'),
        });
        breakpoint.add_setter(split, 'collapsed', true);
        this.add_breakpoint(breakpoint);

        // Sidebar: the thread list
        const sidebarToolbar = new Adw.ToolbarView();
        const sidebarHeader = new Adw.HeaderBar();
        const newButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('New Conversation'),
            valign: Gtk.Align.CENTER,
        });
        newButton.update_property([Gtk.AccessibleProperty.LABEL], [_('New Conversation')]);
        newButton.connect('clicked', this._onNewConversation.bind(this));
        sidebarHeader.pack_start(newButton);
        sidebarHeader.title_widget = new Adw.WindowTitle({
            title: _('Messaging'),
            subtitle: '',
        });
        sidebarToolbar.add_top_bar(sidebarHeader);

        this.thread_list = new Gtk.ListBox({vexpand: true});
        this.thread_list.add_css_class('navigation-sidebar');
        this.thread_list.add_css_class('thread-list');
        this.thread_list.connect('row-activated', this._onThreadSelected.bind(this));

        const listPlaceholder = createPlaceholder(
            'view-list-symbolic',
            96,
            _('No Conversations')
        );
        listPlaceholder.append(new Gtk.LinkButton({
            label: _('Help'),
            uri: 'https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Help#contacts-dont-sync',
        }));
        this.thread_list.set_placeholder(listPlaceholder);

        sidebarToolbar.set_content(new Gtk.ScrolledWindow({
            child: this.thread_list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));

        split.set_sidebar(new Adw.NavigationPage({
            title: _('Messaging'),
            child: sidebarToolbar,
        }));

        // Content: the conversation stack
        const contentToolbar = new Adw.ToolbarView();
        const contentHeader = new Adw.HeaderBar();
        this.headerbar = new Adw.WindowTitle({title: _('Messaging'), subtitle: ''});
        contentHeader.title_widget = this.headerbar;
        contentToolbar.add_top_bar(contentHeader);

        this.infobar = new Adw.Banner({title: _('Device is disconnected')});
        contentToolbar.add_top_bar(this.infobar);

        this.stack = new Gtk.Stack({
            hexpand: true,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
        });
        this.stack.add_named(
            createPlaceholder(
                'sms-symbolic',
                144,
                _('No conversation selected'),
                _('Select or start a conversation')
            ),
            'placeholder'
        );
        contentToolbar.set_content(this.stack);

        split.set_content(new Adw.NavigationPage({
            title: _('Conversation'),
            child: contentToolbar,
        }));
    }

    _onCloseRequest() {
        this.saveGeometry();

        GLib.source_remove(this._timestampThreadsId);
        this.contact_chooser.disconnect(this._numberSelectedId);
        this.contact_chooser.cleanup();
        this.plugin.disconnect(this._threadsChangedId);

        for (const child of stackChildren(this.stack)) {
            if (child instanceof Conversation)
                child.cleanup();
        }

        return false;
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        return this.stack.visible_child_name;
    }

    set thread_id(thread_id) {
        thread_id = `${thread_id}`; // FIXME

        // Reset to the empty placeholder
        if (!thread_id) {
            this.thread_list.select_row(null);
            this.stack.set_visible_child_name('placeholder');
            return;
        }

        // Create a conversation widget if there isn't one
        let conversation = this.stack.get_child_by_name(thread_id);
        const thread = this.plugin.threads[thread_id];

        if (conversation === null) {
            if (!thread) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new Conversation({
                device: this.device,
                plugin: this.plugin,
                thread_id: thread_id,
            });

            this.stack.add_named(conversation, thread_id);
        }

        // Figure out whether this is a multi-recipient thread
        this._setHeaderBar(thread[0].addresses);

        // Select the conversation and entry active
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.grab_focus();
        this.split_view.show_content = true;

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread_id');
    }

    _setHeaderBar(addresses = []) {
        const address = addresses[0].address;
        const contact = this.device.contacts.query({number: address});

        if (addresses.length === 1) {
            this.headerbar.title = contact.name;
            this.headerbar.subtitle = Contacts.getDisplayNumber(contact, address, false);
        } else {
            const otherLength = addresses.length - 1;

            this.headerbar.title = contact.name;
            this.headerbar.subtitle = ngettext(
                'And %d other contact',
                'And %d others',
                otherLength
            ).format(otherLength);
        }
    }

    _sync() {
        this.device.contacts.fetch();
        this.plugin.connected();
    }

    _onNewConversation() {
        this._sync();
        this.stack.set_visible_child_name('contact-chooser');
        this.thread_list.select_row(null);
        this.contact_chooser.entry.grab_focus();
        this.split_view.show_content = true;
    }

    _onNumberSelected(chooser, number) {
        const contacts = chooser.getSelected();
        const row = this._getRowForContacts(contacts);

        if (row)
            row.emit('activate');
        else
            this.setContacts(contacts);
    }

    /**
     * Threads
     */
    _onThreadsChanged() {
        // Get the last message in each thread
        const messages = {};

        for (const [thread_id, thread] of Object.entries(this.plugin.threads)) {
            const message = thread[thread.length - 1];

            // Skip messages without a body (eg. MMS messages without text)
            if (message.body)
                messages[thread_id] = thread[thread.length - 1];
        }

        // Update existing summaries and destroy old ones
        for (const row of children(this.thread_list)) {
            const message = messages[row.thread_id];

            // If it's an existing conversation, update it
            if (message) {
                // Ensure there's a contact mapping
                const sender = message.addresses[0].address || 'unknown';

                if (row.contacts[sender] === undefined) {
                    row.contacts[sender] = this.device.contacts.query({
                        number: sender,
                    });
                }

                row.message = message;
                delete messages[row.thread_id];

            // Otherwise destroy it
            } else {
                // Destroy the conversation widget
                const conversation = this.stack?.get_child_by_name(`${row.thread_id}`);

                if (conversation) {
                    if (conversation.cleanup)
                        conversation.cleanup();

                    this.stack.remove(conversation);
                }

                // Then the summary widget
                this.thread_list.remove(row);
            }
        }

        // What's left in the dictionary is new summaries
        for (const message of Object.values(messages)) {
            const contacts = this.device.contacts.lookupAddresses(message.addresses);
            const conversation = new ConversationSummary(contacts, message);
            this.thread_list.append(conversation);
        }

        // Re-sort the summaries
        this.thread_list.invalidate_sort();
    }

    // GtkListBox::row-activated
    _onThreadSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.thread_id = row.thread_id;

        // Show the placeholder
        } else {
            this.headerbar.title = _('Messaging');
            this.headerbar.subtitle = this.device.name;
        }
    }

    _sortThreads(row1, row2) {
        return (row1.date > row2.date) ? -1 : 1;
    }

    _timestampThreads() {
        if (this.visible) {
            for (const row of children(this.thread_list))
                row.update();
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for {@link contacts}
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

        for (const row of children(this.thread_list)) {
            if (row.message.thread_id === thread_id)
                return row;
        }

        return null;
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

        // We're creating a new conversation
        const conversation = new Conversation({
            device: this.device,
            plugin: this.plugin,
            addresses: addresses,
        });

        // Set the headerbar
        this._setHeaderBar(addresses);

        // Select the conversation and entry active
        this.stack.add_named(conversation, thread_id);
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.grab_focus();

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread-id');
    }

    _includesAddress(addresses, addressObj) {
        for (const haystackObj of addresses) {
            if (addressObj.address.equalsPhoneNumber(haystackObj.address))
                return true;
        }
        return false;
    }

    /**
     * Try and find an existing conversation widget for {@link message}.
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
        const conversation = this.stack.get_child_by_name(thread_id);

        if (conversation !== null)
            return conversation;

        // Try and find one by matching addresses, which is necessary if we've
        // started a thread locally and haven't set the thread_id
        const addresses = message.addresses;

        for (const conversation of stackChildren(this.stack)) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length)
                continue;

            const caddrs = conversation.addresses;

            // If we find a match, set `thread-id` on the conversation and the
            // page `name`.
            if (addresses.every(addr => this._includesAddress(caddrs, addr))) {
                conversation._thread_id = thread_id;
                this.stack.get_page(conversation).name = thread_id;

                return conversation;
            }
        }

        return null;
    }

    /**
     * Set the contents of the message entry. If {@link pending} is %false set
     * the message of the currently selected conversation, otherwise mark the
     * message to be set for the next selected conversation.
     *
     * @param {string} message - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    setMessage(message, pending = false) {
        try {
            if (pending)
                this._pendingShare = message;
            else
                this.stack.visible_child.setMessage(message);
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * An Adw.ApplicationWindow for selecting from open conversations
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
}, class ConversationChooser extends Adw.ApplicationWindow {

    _init(params) {
        super._init({
            application: params.application,
            title: _('Share Link'),
            default_width: 300,
            default_height: 300,
            device: params.device,
            message: params.message,
            plugin: params.plugin,
        });

        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        // HeaderBar
        this.headerbar = new Adw.HeaderBar({
            title_widget: new Adw.WindowTitle({
                title: _('Share Link'),
                subtitle: this.message,
            }),
        });
        this.headerbar.tooltip_text = this.message;
        toolbar.add_top_bar(this.headerbar);

        const newButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('New Conversation'),
        });
        newButton.update_property([Gtk.AccessibleProperty.LABEL], [_('New Conversation')]);
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        this.thread_list = new Gtk.ListBox({
            activate_on_single_click: false,
        });
        this.thread_list.add_css_class('navigation-sidebar');
        this.thread_list.set_sort_func(Window.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));

        toolbar.set_content(new Gtk.ScrolledWindow({
            child: this.thread_list,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));

        // Filter Setup
        Window.prototype._onThreadsChanged.call(this);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (controller, keyval) => {
            if (keyval === Gdk.KEY_Escape) {
                this.close();
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        });
        this.add_controller(keys);
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _new(button) {
        const message = this.message;
        this.close();

        this.plugin.sms();
        this.plugin.window._onNewConversation();
        this.plugin.window._pendingShare = message;
    }

    _select(box, row) {
        this.plugin.sms();
        this.plugin.window.thread_id = row.message.thread_id.toString();
        this.plugin.window.setMessage(this.message);

        this.close();
    }
});
