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
    let date = new Date(time);
    let now = new Date();
    let diff = now - time;

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
    let date = new Date(time);
    let now = new Date();
    let diff = now - time;

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
    let incoming = row.message.type === Sms.MessageBox.INBOX;

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
 * A ListBoxRow for a preview of a conversation
 */
const ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectMessagingConversationMessage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-message.ui',
    Children: ['grid', 'avatar', 'sender-label', 'message-label'],
}, class ConversationMessage extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init();

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

            this.message_label.get_style_context().add_class('message-in');
            this.message_label.halign = Gtk.Align.START;
        } else {
            this.message_label.get_style_context().add_class('message-out');
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
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
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
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
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
            let address = this.addresses[i].address;
            let contact = this.device.contacts.query({number: address});

            // Get corrected address
            let number = address.toPhoneNumber();

            for (let contactNumber of contact.numbers) {
                let cnumber = contactNumber.value.toPhoneNumber();

                if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
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
        let thread = this.plugin.threads[thread_id];
        let message = (thread) ? thread[0] : null;

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
            this.logPrevious();

        // Release any hold to resume auto-scrolling
        else if (pos === Gtk.PositionType.BOTTOM)
            this._releasePosition();
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onKeyPressEvent(entry, event) {
        let keyval = event.get_keyval()[1];
        let state = event.get_state()[1];
        let mask = state & Gtk.accelerator_get_default_mod_mask();

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
        let message = new Gtk.Label({
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
        let upper = this._vadj.get_upper();
        let pageSize = this._vadj.get_page_size();

        // If the scrolled window hasn't been filled yet, load another message
        if (upper <= pageSize) {
            this.logPrevious();
            this.scrolled.get_child().check_resize();

        // We've been asked to hold the position, so we'll reset the adjustment
        // value and update the hold position
        } else if (this.__pos) {
            this._vadj.set_value(upper - this.__pos);

        // Otherwise we probably appended a message and should scroll to it
        } else {
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
        let sender = message.addresses[0].address || 'unknown';

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
                header = new Gtk.Label({visible: true});
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
     * Log the next message in the conversation.
     *
     * @param {Object} message - A message object
     */
    logNext(message) {
        try {
            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                throw TypeError(`invalid message box ${message.type}`);

            // Append the message
            let row = this._createMessageRow(message);
            this.list.add(row);
            this.list.invalidate_headers();

            // Remove the first pending message
            if (this.has_pending && message.type === Sms.MessageBox.SENT) {
                this.pending_box.get_children()[0].destroy();
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
            let message = this.__messages.pop();

            if (!message)
                return;

            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                throw TypeError(`invalid message box ${message.type}`);

            // Prepend the message
            let row = this._createMessageRow(message);
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

        // Contact Name
        let nameLabel = _('Unknown Contact');

        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this.avatar.contact = this.contacts[this._sender];
            nameLabel = GLib.markup_escape_text(this.avatar.contact.name, -1);
        } else {
            this.avatar.contact = null;
            nameLabel = _('Group Message');
            let participants = [];
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
        let timeLabel = `<small>${getShortTime(message.date)}</small>`;
        this.time_label.label = timeLabel;
    }

    /**
     * Update the relative time label.
     */
    update() {
        let timeLabel = `<small>${getShortTime(this.message.date)}</small>`;
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
        let thread = this.plugin.threads[thread_id];

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
        let address = addresses[0].address;
        let contact = this.device.contacts.query({number: address});

        if (addresses.length === 1) {
            this.headerbar.title = contact.name;
            this.headerbar.subtitle = Contacts.getDisplayNumber(contact, address);
        } else {
            let otherLength = addresses.length - 1;

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
        let contacts = chooser.getSelected();
        let row = this._getRowForContacts(contacts);

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
        let messages = {};

        for (let [thread_id, thread] of Object.entries(this.plugin.threads)) {
            let message = thread[thread.length - 1];

            // Skip messages without a body (eg. MMS messages without text)
            if (message.body)
                messages[thread_id] = thread[thread.length - 1];
        }

        // Update existing summaries and destroy old ones
        for (let row of this.thread_list.get_children()) {
            let message = messages[row.thread_id];

            // If it's an existing conversation, update it
            if (message) {
                // Ensure there's a contact mapping
                let sender = message.addresses[0].address || 'unknown';

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
                let conversation = this.stack.get_child_by_name(`${row.thread_id}`);

                if (conversation) {
                    conversation.destroy();
                    imports.system.gc();
                }

                // Then the summary widget
                row.destroy();
                // HACK: temporary mitigator for mysterious GtkListBox leak
                imports.system.gc();
            }
        }

        // What's left in the dictionary is new summaries
        for (let message of Object.values(messages)) {
            let contacts = this.device.contacts.lookupAddresses(message.addresses);
            let conversation = new ConversationSummary(contacts, message);
            this.thread_list.add(conversation);
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
        let addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });

        // Try to find a thread_id
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        for (let row of this.thread_list.get_children()) {
            if (row.message.thread_id === thread_id)
                return row;
        }

        return null;
    }

    setContacts(contacts) {
        // Group the addresses
        let addresses = [];

        for (let address of Object.keys(contacts))
            addresses.push({address: address});

        // Try to find a thread ID for this address group
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        if (thread_id === null)
            thread_id = GLib.uuid_string_random();
        else
            thread_id = thread_id.toString();

        // Try to find a thread row for the ID
        let row = this._getRowForContacts(contacts);

        if (row !== null) {
            this.thread_list.select_row(row);
            return;
        }

        // We're creating a new conversation
        let conversation = new Conversation({
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
        let number = addressObj.address.toPhoneNumber();

        for (let haystackObj of addresses) {
            let tnumber = haystackObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number))
                return true;
        }

        return false;
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
        let thread_id = `${message.thread_id}`;
        let conversation = this.stack.get_child_by_name(thread_id);

        if (conversation !== null)
            return conversation;

        // Try and find one by matching addresses, which is necessary if we've
        // started a thread locally and haven't set the thread_id
        let addresses = message.addresses;

        for (let conversation of this.stack.get_children()) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length)
                continue;

            let caddrs = conversation.addresses;

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
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
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
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
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

        let newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true,
        });
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        let scrolledWindow = new Gtk.ScrolledWindow({
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
        let message = this.message;
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

