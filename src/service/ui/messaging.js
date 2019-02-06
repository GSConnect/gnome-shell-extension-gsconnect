'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;
const Sms = imports.service.plugins.sms;


/**
 * Return a human-readable timestamp.
 *
 * @param {Number} time - Milliseconds since the epoch (local time)
 * @return {String} - A timestamp similar to what Android Messages uses
 */
function getTime(time) {
    time = GLib.DateTime.new_from_unix_local(time / 1000);
    let now = GLib.DateTime.new_now_local();
    let diff = now.difference(time);

    switch (true) {
        // Super recent
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        // Under an hour
        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext('%d minute', '%d minutes', (diff / GLib.TIME_SPAN_MINUTE)).format(diff / GLib.TIME_SPAN_MINUTE);

        // Yesterday, but less than 24 hours ago
        case (diff < GLib.TIME_SPAN_DAY && (now.get_day_of_month() !== time.get_day_of_month())):
            // TRANSLATORS: Yesterday, but less than 24 hours (eg. Yesterday · 11:29 PM)
            return _('Yesterday・%s').format(time.format('%l:%M %p'));

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return time.format('%l:%M %p');

        // Less than a week ago
        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return time.format('%A・%l:%M %p');

        default:
            return time.format('%b %e');
    }
}


function getShortTime(time) {
    time = GLib.DateTime.new_from_unix_local(time / 1000);
    let diff = GLib.DateTime.new_now_local().difference(time);

    switch (true) {
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext('%d minute', '%d minutes', (diff / GLib.TIME_SPAN_MINUTE)).format(diff / GLib.TIME_SPAN_MINUTE);

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return time.format('%l:%M %p');

        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return time.format('%a');

        default:
            return time.format('%b %e');
    }
}


/**
 * A simple GtkLabel subclass with a chat bubble appearance
 */
var ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectConversationMessage'
}, class ConversationMessage extends Gtk.Label {

    _init(message) {
        this.message = message;
        let incoming = (message.type === Sms.MessageType.INBOX);

        super._init({
            label: message.body.linkify(message.date),
            halign: incoming ? Gtk.Align.START : Gtk.Align.END,
            selectable: true,
            tooltip_text: getTime(message.date),
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0
        });

        if (incoming) {
            this.get_style_context().add_class('message-in');
        } else {
            this.get_style_context().add_class('message-out');
        }
    }

    vfunc_activate_link(uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `http://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip) {
        if (super.vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip)) {
            tooltip.set_text(getTime(this.message.date));
            return true;
        }

        return false;
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
const ConversationSummary = GObject.registerClass({
    GTypeName: 'GSConnectConversationSummary'
}, class ConversationSummary extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init({visible: true});

        // Row layout
        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        this.add(grid);

        // Contact Avatar
        this._avatar = new Contacts.Avatar(contact);
        grid.attach(this._avatar, 0, 0, 1, 3);

        // Contact Name
        this._name = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._name, 1, 0, 1, 1);

        // Message Time
        this._time = new Gtk.Label({
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        this._time.get_style_context().add_class('dim-label');
        grid.attach(this._time, 2, 0, 1, 1);

        // Message Body
        this._body = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._body, 1, 1, 2, 1);

        this.contact = contact;
        this.message = message;
    }

    get id() {
        return this._message.thread_id;
    }

    get message() {
        return this._message;
    }

    set message(message) {
        this._message = message;

        // Contact Name & Message body
        let nameLabel = this.contact.name;
        let bodyLabel = message.body.split(/\r|\n/)[0];
        bodyLabel = GLib.markup_escape_text(bodyLabel, -1);

        // Ignore the 'read' flag if it's an outgoing message
        if (message.type === Sms.MessageType.SENT) {
            // TRANSLATORS: An outgoing message body in a conversation summary
            bodyLabel = _('You: %s').format(bodyLabel);

        // Otherwise make it bold if it's unread
        } else if (message.read === Sms.MessageStatus.UNREAD) {
            nameLabel = '<b>' + nameLabel + '</b>';
            bodyLabel = '<b>' + bodyLabel + '</b>';
        }

        // Set the labels, body always smaller
        this._name.label = nameLabel;
        this._body.label = '<small>' + bodyLabel + '</small>';

        // Time
        let timeLabel = '<small>' + getShortTime(message.date) + '</small>';
        this._time.label = timeLabel;
    }

    update() {
        let timeLabel = '<small>' + getShortTime(this.message.date) + '</small>';
        this._time.label = timeLabel;
    }
});


const ConversationWidget = GObject.registerClass({
    GTypeName: 'GSConnectConversationWidget',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'address': GObject.ParamSpec.string(
            'address',
            'Address',
            'The target phone number or other address',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            ''
        ),
        'has-pending': GObject.ParamSpec.boolean(
            'has-pending',
            'Has Pending',
            'Whether there are sent messages pending confirmation',
            GObject.ParamFlags.READABLE,
            false
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/conversation.ui',
    Children: [
        'message-entry', 'message-list', 'message-window',
        'pending', 'pending-box'
    ]
}, class ConversationWidget extends Gtk.Grid {

    _init(params) {
        this.connect_template();
        super._init(params);

        this.device.bind_property(
            'connected',
            this.message_entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        // Pending messages
        this.pending.id = GLib.MAXUINT32;
        this.bind_property(
            'has-pending',
            this.pending,
            'visible',
            GObject.BindingFlags.DEFAULT
        );

        this._notifications = [];

        // Message List
        this.message_list.set_header_func(this._headerMessages);
        this.message_list.set_sort_func(this._sortMessages);
        this._populateMessages();

        // HACK: This property was added in gtk-3.24; if it's not present this
        // will just become a useless JS variable instead of choking
        this.message_entry.enable_emoji_completion = true;
    }

    get address() {
        if (this._address === undefined) {
            this._address = null;
        }

        return this._address;
    }

    set address(value) {
        this._address = value;
    }

    get contact() {
        // Ensure we have a contact and hold a reference to it
        if (!this._contact) {
            this._contact = this.device.contacts.query({number: this.address});
        }

        return this._contact;
    }

    get has_pending() {
        return (this.pending_box.get_children().length);
    }

    get sms() {
        if (this._sms === undefined) {
            this._sms = this.device.lookup_plugin('sms');
        }

        return this._sms;
    }

    _onConnected(device) {
        if (device.connected) {
            this.pending_box.foreach(msg => msg.destroy());
        }
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation.disconnect_template();

        conversation.message_list.foreach(message => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            message.run_dispose();
            imports.system.gc();
        });
    }

    /**
     * Messages
     */
    _populateMessages() {
        this.__first = null;
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a conversation for this number
        let number = this.address.toPhoneNumber();
        let thread_id = null;

        for (let thread of Object.values(this.sms.conversations)) {
            let tnumber = thread[0].address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                thread_id = thread[0].thread_id;
                break;
            }
        }

        if (this.sms.conversations[thread_id]) {
            this.__messages = this.sms.conversations[thread_id].slice(0);
            this._populateBack();
        }
    }

    /**
     * Populate messages in reverse, in chunks of series
     */
    _populateBack() {
        // Keep track of direction and date
        let date, direction;

        while (this.__messages.length > 0) {
            let message = this.__messages[this.__messages.length - 1];

            // TODO: Unsupported MessageType
            if (message.type !== 1 && message.type !== 2) {
                this.__messages.pop();
                continue;
            }

            date = date || message.date;
            direction = direction || message.type;

            // Break if we're definitely at the end of series
            if (message.type !== direction) break;

            // Start a new series if this is the first
            if (!this.__first) {
                this.__first = this._createSeries(message);
                this.__last = this.__first;
                this.message_list.prepend(this.__first);

            // ...or there's more than an hour difference
            } else if (date - message.date > GLib.TIME_SPAN_HOUR / 1000) {
                this.__first = this._createSeries(message);
                this.message_list.prepend(this.__first);

            // ...or it's in a different direction
            } else if (message.type !== this.__first.type) {
                this.__first = this._createSeries(message);
                this.message_list.prepend(this.__first);
            }

            // Create a message, set the message id and prepend it
            let widget = new ConversationMessage(this.__messages.pop());
            this.__first.id = message._id;
            this.__first.messages.pack_end(widget, false, false, 0);

            // update the date tracker
            date = message.date;
        }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending') return;

        // Check if the last series was more than an hour ago
        if (before && (row.date - before.date) > GLib.TIME_SPAN_HOUR / 1000) {
            let header = new Gtk.Label({
                label: getTime(row.date),
                visible: true
            });
            header.get_style_context().add_class('dim-label');
            row.set_header(header);
        }
    }

    _sortMessages(row1, row2) {
        if (row1.id > row2.id) {
            return 1;
        }

        return -1;
    }

    // message-entry::focus-in-event
    // FIXME: this is not working well
    _onMessageAcknowledged() {
        if (this.message_entry.has_focus) {
            let notification = this.device.lookup_plugin('notification');

            if (notification) {
                while (this._notifications.length > 0) {
                    notification.closeNotification(this._notifications.pop());
                }
            }
        }
    }

    // message-list::size-allocate
    _onMessageLogged(listbox, allocation) {
        let vadj = this.message_window.vadjustment;

        // Try loading more messages if there's room
        if (vadj.get_upper() <= vadj.get_page_size()) {
            this._populateBack();
            this.message_window.get_child().check_resize();

        // We've been asked to hold the position
        } else if (this.__pos) {
            vadj.set_value(vadj.get_upper() - this.__pos);
            this.__pos = 0;

        // Otherwise scroll to the bottom
        } else {
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        }

        this._onMessageAcknowledged();
    }

    // message-window::edge-reached
    _onMessageRequested(scrolled_window, pos) {
        if (pos === Gtk.PositionType.TOP) {
            this.__pos = this.message_window.vadjustment.get_upper();
            this._populateBack();
        }
    }

    /**
     * Add a new row representing a series of sequential messages from one
     * contact with a single instance of their avatar.
     *
     * @param {object} message - The message object to create a series for
     */
    _createSeries(message) {
        let incoming = (message.type === Sms.MessageType.INBOX);

        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true
        });
        row.date = message.date;
        row.id = message._id;
        row.type = message.type;

        let layout = new Gtk.Box({
            can_focus: false,
            hexpand: true,
            margin: 6,
            spacing: 6,
            halign: incoming ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(layout);

        // Add avatar for incoming messages
        if (incoming) {
            let avatar = new Contacts.Avatar(this.contact);
            avatar.valign = Gtk.Align.END;
            layout.add(avatar);
        }

        // Messages
        row.messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            halign: layout.halign,
            // Avatar width (32px) + layout spacing (6px) + 6px
            margin_end: incoming ? 44 : 0,
            margin_start: incoming ? 0 : 44
        });
        layout.add(row.messages);

        row.show_all();

        return row;
    }

    /**
     * Log a new message in the conversation
     *
     * @param {Object} message - A sms message object
     */
    logMessage(message) {
        // TODO: Unsupported MessageType
        if (message.type !== 1 && message.type !== 2) return;

        // Ensure it's older than the last message (or the first)
        // TODO: with a lot of work we could probably handle this...
        if (this.__last && this.__last.id > message._id) {
            warning('SMS message out of order', this.device.name);
            return;
        }

        // Start a new series if this is the first
        if (!this.__first) {
            this.__first = this._createSeries(message);
            this.__last = this.__first;
            this.message_list.add(this.__first);

        // ...or there's more than an hour difference
        } else if (message.date - this.__last.date > GLib.TIME_SPAN_HOUR / 1000) {
            this.__last = this._createSeries(message);
            this.message_list.add(this.__last);

        // ...or it's in a different direction
        } else if (message.type !== this.__last.type) {
            this.__last = this._createSeries(message);
            this.message_list.add(this.__last);
        }

        // Create a message, set the message id/date and append it
        let widget = new ConversationMessage(message);
        this.__last.id = message._id;
        this.__last.date = message.date;
        this.__last.messages.pack_start(widget, false, false, 0);

        // Remove the first pending message
        if (this.has_pending && message.type === Sms.MessageType.SENT) {
            this.pending_box.get_children()[0].destroy();
            this.notify('has-pending');
        }
    }

    /**
     * Message Entry
     */
    // GtkEditable::changed
    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    /**
     * Send the contents of the message entry to the address
     */
    sendMessage(entry, signal_id, event) {
        // Don't send empty texts
        if (!this.message_entry.text.trim()) return;

        // Send the message
        this.device.activate_action(
            'sendSms',
            new GLib.Variant('(ss)', [this.address, entry.text])
        );

        // Log the message as pending
        let message = new ConversationMessage({
            body: entry.text,
            date: Date.now(),
            type: Sms.MessageType.SENT
        });
        this.pending_box.add(message);
        this.notify('has-pending');

        // Clear the entry
        this.message_entry.text = '';
    }

    /**
     * Set the contents of the message entry
     *
     * @param {String} text - The message to place in the entry
     */
    setMessage(text) {
        this.message_entry.text = text;
        this.message_entry.emit('move-cursor', 0, text.length, false);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var Window = GObject.registerClass({
    GTypeName: 'GSConnectMessagingWindow',
    Properties: {
        'address': GObject.ParamSpec.string(
            'address',
            'Address',
            'The phone number of the active conversation',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/messaging.ui',
    Children: [
        'headerbar', 'infobar',
        'conversation-list', 'conversation-list-placeholder', 'conversation-stack'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        this.connect_template();
        super._init(params);
        this.headerbar.subtitle = this.device.name;

        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup('org.gnome.Shell.Extensions.GSConnect.Messaging', true),
            path: '/org/gnome/shell/extensions/gsconnect/messaging/'
        });

        this.insert_action_group('device', this.device);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        this.restore_geometry();

        // Contacts
        this.contact_list = new Contacts.ContactChooser({
            device: this.device,
            store: this.device.contacts
        });
        this.conversation_stack.add_named(this.contact_list, 'contact-list');

        this._numberSelectedId = this.contact_list.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Conversations
        this.conversation_list.set_sort_func(this._sortConversations);

        this._conversationsChangedId = this.sms.connect(
            'notify::conversations',
            this._onConversationsChanged.bind(this)
        );

        this._timestampConversationsId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            60,
            this._timestampConversations.bind(this)
        );

        // Conversations Placeholder
        this.conversation_list.set_placeholder(this.conversation_list_placeholder);

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        this._sync();
        this._onConversationsChanged();
    }

    vfunc_delete_event(event) {
        this.save_geometry();
        return this.hide_on_delete();
    }

    get address() {
        return this.conversation_stack.visible_child_name;
    }

    set address(address) {
        if (!address) {
            this.conversation_list.select_row(null);
            this.conversation_stack.set_visible_child_name('placeholder');
            return;
        }

        // Get a contact object for this address
        let contact = this.device.contacts.query({number: address});

        // Set the header bar title/subtitle
        this.headerbar.title = contact.name;
        this.headerbar.subtitle = address;

        // See if we have a nicer display number
        let number = address.toPhoneNumber();

        for (let contactNumber of contact.numbers) {
            let cnumber = contactNumber.value.toPhoneNumber();

            if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                this.headerbar.subtitle = contactNumber.value;
                break;
            }
        }

        // Create a conversation widget if there isn't one
        let conversation = this.getConversation(address);

        if (conversation === null) {
            conversation = new ConversationWidget({
                device: this.device,
                address: address
            });

            this.conversation_stack.add_named(conversation, address);
        }

        // Select the conversation and entry active
        this.conversation_stack.visible_child = conversation;
        this.conversation_stack.visible_child.message_entry.has_focus = true;

        // There was a pending message waiting for a contact to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }
    }

    get sms() {
        if (!this._sms) {
            this._sms = this.device.lookup_plugin('sms');
        }

        return this._sms;
    }

    _sync() {
        // Contacts
        let contacts = this.device.lookup_plugin('contacts');

        if (contacts) {
            contacts.connected();
        } else {
            this.device.contacts._loadFolks();
        }

        // SMS history
        this.sms.connected();
    }

    _onDestroy(window) {
        GLib.source_remove(window._timestampConversationsId);
        window.contact_list.disconnect(window._numberSelectedId);
        window.sms.disconnect(window._conversationsChangedId);
        window.disconnect_template();
    }

    _onNewConversation() {
        this._sync();
        this.conversation_stack.set_visible_child_name('contact-list');
        this.conversation_list.select_row(null);
        this.contact_list.contact_entry.has_focus = true;
    }

    _onNumberSelected(list, number) {
        let summary = this.getSummary(number);
        this.conversation_list.select_row(summary);
        this.address = number;
    }

    /**
     * Conversations
     */
    _onConversationsChanged() {
        let messages = new Map();

        for (let thread of Object.values(this.sms.conversations)) {
            let message = thread[thread.length - 1];
            messages.set(message.thread_id, message);
        }

        // Update existing summaries and destroy old ones
        for (let summary of this.conversation_list.get_children()) {
            let message = messages.get(summary.id);

            // If it's an existing conversation, update it
            if (message) {
                summary.message = message;
                messages.delete(summary.id);

            // Otherwise destroy it
            } else {
                // HACK: temporary mitigator for mysterious GtkListBox leak
                summary.run_dispose();
                imports.system.gc();

                // Also delete the conversation
                let conversation = this.getConversation(summary.message.address);

                if (conversation) {
                    conversation.run_dispose();
                    imports.system.gc();
                }
            }
        }

        // Add new summaries
        for (let message of messages.values()) {
            let contact = this.device.contacts.query({number: message.address});
            let conversation = new ConversationSummary(contact, message);
            this.conversation_list.add(conversation);
        }

        // Re-sort the summaries
        this.conversation_list.invalidate_sort();
    }

    _onConversationSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.address = row.message.address;

        // Show the placeholder
        } else {
            this.headerbar.title = _('Messaging');
            this.headerbar.subtitle = this.device.name;
        }
    }

    _sortConversations(row1, row2) {
        return (row1.message.date > row2.message.date) ? -1 : 1;
    }

    _timestampConversations() {
        if (this.visible) {
            this.conversation_list.foreach(summary => summary.update());
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the conversation widget for an address
     *
     * @param {string} address - A contact address
     * @return {ConversationWidget|null} - The conversation widget or %null
     */
    getConversation(address) {
        let number = address.toPhoneNumber();

        for (let conversation of this.conversation_stack.get_children()) {
            // Skip contact list
            if (!conversation.address) continue;

            let cnumber = conversation.address.toPhoneNumber();

            if (cnumber.endsWith(number) || number.endsWith(cnumber)) {
                return conversation;
            }
        }

        return null;
    }

    /**
     * Find the conversation summary row for an address
     *
     * @param {string} address - A contact address
     * @return {ConversationSummary|null} - The conversation summary or %null
     */
    getSummary(address) {
        let number = address.toPhoneNumber();

        for (let summary of this.conversation_list.get_children()) {
            let cnumber = summary.message.address.toPhoneNumber();

            if (cnumber.endsWith(number) || number.endsWith(cnumber)) {
                return summary;
            }
        }

        return null;
    }

    /**
     * Set the contents of the message entry. If @pending is %false set the
     * message of the currently selected conversation, otherwise mark the
     * message to be set for the next selected conversation.
     *
     * @param {String} text - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    setMessage(message, pending = false) {
        try {
            if (pending) {
                this._pendingShare = message;
            } else {
                this.conversation_stack.visible_child.setMessage(message);
            }
        } catch (e) {
            warning(e);
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
        )
    }
}, class ConversationChooser extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(Object.assign({
            title: _('Share Link'),
            default_width: 300,
            default_height: 200
        }, params));
        this.set_keep_above(true);

        // HeaderBar
        let headerbar = new Gtk.HeaderBar({
            title: _('Share Link'),
            subtitle: this.message,
            show_close_button: true,
            tooltip_text: this.message
        });
        this.set_titlebar(headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true
        });
        newButton.connect('clicked', this._new.bind(this));
        headerbar.pack_start(newButton);

        // Conversations
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.conversation_list = new Gtk.ListBox({
            activate_on_single_click: false
        });
        this.conversation_list.set_sort_func(Window.prototype._sortConversations);
        this.conversation_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.conversation_list);

        // Filter Setup
        Window.prototype._populateConversations.call(this);
        this.show_all();
    }

    get sms() {
        if (this._sms === undefined) {
            this._sms = this.device.lookup_plugin('sms');
        }

        return this._sms;
    }

    _new(button) {
        let message = this.message;
        this.destroy();

        this.sms.sms();
        this.sms.window.address = null;
        this.sms.window._pendingShare = message;
    }

    _select(box, row) {
        this.sms.sms();
        this.sms.window.address = row.message.address;
        this.sms.window.setMessage(this.message);

        this.destroy();
    }
});

