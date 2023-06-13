// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const Tweener = imports.tweener.tweener;

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;
const Sms = imports.service.plugins.sms;
const URI = imports.service.utils.uri;


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
 * @return {string} A localized timestamp similar to what Android Messages uses
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
 * @return {string} A localized timestamp similar to what Android Messages uses
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
 * @return {string} A localized timestamp
 */
function getDetailedTime(time) {
    return _cFormat.format(time);
}


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
 * A ListBoxRow for each message of a conversation
 */
const ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationMessage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-message.ui',
    Children: [
        'grid', 'avatar', 'sender-label', 'message-label', 'attachment-box',
    ],
}, class ConversationMessage extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init();

        this.contact = contact;
        this.message = message;
        this.sender = message.addresses[0].address || 'unknown';

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

            this.avatar.contact = this.contact;
            this.avatar.visible = true;

            this.sender_label.label = contact.name;
            this.sender_label.visible = true;

            this.message_label.get_style_context().add_class('message-in');
            this.message_label.halign = Gtk.Align.START;
        } else {
            this.message_label.get_style_context().add_class('message-out');
        }

        if (!has_attachments)
            return;

        // Append attachment thumbnails to message content
        message.attachments.forEach((attachment) => {
            this._add_thumb(attachment.encoded_thumbnail);
        });
        this.attachment_box.show_all();
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
        'pending', 'pending-box',
    ],
}, class MessagingConversation extends Gtk.Grid {

    _init(params) {
        super._init({
            device: params.device,
            plugin: params.plugin,
        });
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
        this._ids = new Set();

        // Pending messages
        this.pending.message = {
            date: Number.MAX_SAFE_INTEGER,
            type: Sms.MessageBox.OUTBOX,
        };

        // Spinner shown when waiting on history
        this.spinner.message = {
            date: -1,
            type: Sms.MessageBox.INBOX,
        };

        // Auto-scrolling
        this._vadj = this.scrolled.get_vadjustment();
        this._scrolledId = this._vadj.connect(
            'value-changed',
            this._holdPosition.bind(this)
        );

        // Message List
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
        if (this.pending_box === undefined)
            return false;

        return (this.pending_box.get_children().length > 0);
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
            this.pending_box.foreach(msg => msg.destroy());
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation._vadj.disconnect(conversation._scrolledId);

        conversation.list.foreach(message => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            message.destroy();
            imports.system.gc();
        });
    }

    _onEdgeReached(scrolled_window, pos) {
        // Try to load more messages
        if (pos === Gtk.PositionType.TOP)
            this._requestMore();

        // Release any hold to resume auto-scrolling
        else if (pos === Gtk.PositionType.BOTTOM)
            this._releasePosition();
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
        this.pending_box.add(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';
    }

    _onSizeAllocate(listbox, allocation) {
        if (!this.windowFilled) {
            // If the scrolled window hasn't been filled yet, keep loading
            this.scrolled.get_child().check_resize();

        } else if (this.__pos) {
            // We've been asked to hold the position, so we'll reset the adjustment
            // value and update the hold position
            this._vadj.set_value(this._vadj.get_upper() - this.__pos);
        } else {
            // Otherwise we probably appended a message and should scroll to it
            this._scrollPosition(Gtk.PositionType.BOTTOM);
        }
    }

    /**
     * Create a message row, ensuring a contact object has been retrieved or
     * generated for the message.
     *
     * @param {Object} message - A dictionary of message data
     * @return {ConversationMessage} A message row
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
        this.spinner.show_all();
        if (this._spinnerTimeoutID && this._spinnerTimeoutID > 0) {
            this._spinnerTimeoutID.destroy();
        }
        this._spinnerTimeoutID = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            LOADING_TIMEOUT_SECS,
            this._onSpinnerTimeoutExpired
        );
    }

    _onSpinnerTimeoutExpired() {
        this._hide_spinner();
        return GLib.SOURCE_REMOVE;
    }

    /**
     * Disable the loading spinner and/or expiration timer, if running
     */
    _stop_loading_spinner() {
        this._hide_spinner();
        if (this._spinnerTimeoutID === undefined || !this._spinnerTimeoutID) {
            this._spinnerTimeoutID.destroy();
            this._spinnerTimeoutID = 0;
        }
    }

    _hide_spinner() {
        this.spinner_anim.active = false;
        this.spinner.hide();
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
                header = new Gtk.Label({visible: true, selectable: true});
                header.get_style_context().add_class('dim-label');
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
            });
        }
    }

    _sortMessages(row1, row2) {
        return (row1.message.date > row2.message.date) ? 1 : -1;
    }

    /**
     * Add a message to the conversation.
     *
     * @param {Object} message - A message object
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
            this.list.add(row);

            if (message.date > this.latest) {
                this.latest = message.date;

                // Remove the first pending message
                if (this.has_pending && message.type === Sms.MessageBox.SENT) {
                    this.pending_box.get_children()[0].destroy();
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
    Children: ['avatar', 'name-label', 'time-label', 'body-label'],
}, class ConversationSummary extends Gtk.ListBoxRow {
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
        this._sender = message.addresses[0].address || 'unknown';

        // TRANSLATORS: Shown as the summary when a text message contains
        // only image content (no text body)
        const image_placeholder = _('<i>image</i>');

        // Contact Name
        let nameLabel = _('Unknown Contact');

        const sent = message.type === Sms.MessageBox.SENT;
        const unread = message.read === Sms.MessageBox.UNREAD;
        const has_attachments = message['attachments'] !== undefined;

        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this.avatar.contact = this.contacts[this._sender];
            nameLabel = GLib.markup_escape_text(this.avatar.contact.name, -1);
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
        let bodyLabel;
        if (message.body.length) {
            bodyLabel = message.body.split(/\r|\n/)[0];
            bodyLabel = GLib.markup_escape_text(bodyLabel, -1);

            if (sent) {
                // TRANSLATORS: An outgoing message body in a conversation summary
                bodyLabel = _('You: %s').format(bodyLabel);
            }
        } else if (has_attachments) {
            bodyLabel = image_placeholder;
        } else {
            bodyLabel = '';
        }

        // Make it bold if it's unread
        if (unread) {
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
 * A Gtk.ApplicationWindow for SMS conversations
 */
var Window = GObject.registerClass({
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
        'headerbar', 'infobar',
        'thread-list', 'stack',
    ],
}, class MessagingWindow extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(params);
        this.headerbar.subtitle = this.device.name;

        this.insert_action_group('device', this.device);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
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
    }

    vfunc_delete_event(event) {
        this.saveGeometry();

        GLib.source_remove(this._timestampThreadsId);
        this.contact_chooser.disconnect(this._numberSelectedId);
        this.plugin.disconnect(this._threadsChangedId);

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
        const message = this.plugin.getThreadLatestMessage(thread_id);

        if (conversation === null) {
            if (!message) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new Conversation({
                device: this.device,
                plugin: this.plugin,
                thread_id: thread_id,
            });

            this.stack.add_named(conversation, thread_id);
            conversation.addMessage(message);
        }

        // Figure out whether this is a multi-recipient thread
        this._setHeaderBar(message.addresses);

        // Select the conversation and entry active
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.has_focus = true;

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
            this.headerbar.subtitle = Contacts.getDisplayNumber(contact, address);
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
        this.contact_chooser.entry.has_focus = true;
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
        if (this.visible)
            this.thread_list.foreach(row => row.update());

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for @contacts
     *
     * @param {Object[]} contacts - A contact group
     * @return {ConversationSummary|null} The thread row or %null
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
        for (const row of this.thread_list.get_children()) {
            if (row.thread_id === thread_id)
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
        this.stack.visible_child.entry.has_focus = true;

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

        // Update existing summary or create new one
        const row = this._getRowForThread(thread_id);

        // If it's a newer message for an existing conversation, update it
        if (row) {
            if (row.date < timestamp) {
                // Ensure there's a contact mapping
                const sender = message.addresses[0].address || 'unknown';

                if (row.contacts[sender] === undefined) {
                    row.contacts[sender] = this.device.contacts.query({
                        number: sender,
                    });
                }

                row.message = message;

                // Re-sort the summaries
                this.thread_list.invalidate_sort();
            }
        } else {
            const contacts = this.device.contacts.lookupAddresses(message.addresses);
            const new_thread = new ConversationSummary(contacts, message);
            this.thread_list.add(new_thread);
        }

        // If it's a message for the selected conversation, display it
        if (thread_id === this.thread_id) {
            const conversation = this.stack.get_child_by_name(`${thread_id}`);
            conversation.addMessage(message);
        }
    }

    /**
     * Try and find an existing conversation widget for @message.
     *
     * @param {Object} message - A message object
     * @return {Conversation|null} A conversation widget or %null
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

        for (const conversation of this.stack.get_children()) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length)
                continue;

            const caddrs = conversation.addresses;

            // If we find a match, set `thread-id` on the conversation and the
            // child property `name`.
            if (addresses.every(addr => this._includesAddress(caddrs, addr))) {
                conversation._thread_id = thread_id;
                this.stack.child_set_property(conversation, 'name', thread_id);

                return conversation;
            }
        }

        return null;
    }

    /**
     * Set the contents of the message entry. If @pending is %false set the
     * message of the currently selected conversation, otherwise mark the
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
 * A Gtk.ApplicationWindow for selecting from open conversations
 */
var ConversationChooser = GObject.registerClass({
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
}, class ConversationChooser extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(Object.assign({
            title: _('Share Link'),
            default_width: 300,
            default_height: 200,
        }, params));
        this.set_keep_above(true);

        // HeaderBar
        this.headerbar = new Gtk.HeaderBar({
            title: _('Share Link'),
            subtitle: this.message,
            show_close_button: true,
            tooltip_text: this.message,
        });
        this.set_titlebar(this.headerbar);

        const newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true,
        });
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        const scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        this.add(scrolledWindow);

        this.thread_list = new Gtk.ListBox({
            activate_on_single_click: false,
        });
        this.thread_list.set_sort_func(Window.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.thread_list);

        // Filter Setup
        Window.prototype._onThreadsChanged.call(this);
        this.show_all();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _new(button) {
        const message = this.message;
        this.destroy();

        this.plugin.sms();
        this.plugin.window._onNewConversation();
        this.plugin.window._pendingShare = message;
    }

    _select(box, row) {
        this.plugin.sms();
        this.plugin.window.thread_id = row.message.thread_id.toString();
        this.plugin.window.setMessage(this.message);

        this.destroy();
    }
});
