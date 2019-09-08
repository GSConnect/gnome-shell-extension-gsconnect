'use strict';

const Gdk = imports.gi.Gdk;
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
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let now = GLib.DateTime.new_now_local();
    let diff = now.difference(date);

    switch (true) {
        // Super recent
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        // Under an hour
        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Yesterday, but less than 24 hours ago
        case (diff < GLib.TIME_SPAN_DAY && (now.get_day_of_month() !== date.get_day_of_month())):
            // TRANSLATORS: Yesterday, but less than 24 hours (eg. Yesterday · 11:29 PM)
            return _('Yesterday・%s').format(date.format('%l:%M %p'));

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        // Less than a week ago
        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%A・%l:%M %p');

        default:
            return date.format('%b %e');
    }
}


function getShortTime(time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let diff = GLib.DateTime.new_now_local().difference(date);

    switch (true) {
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%a');

        default:
            return date.format('%b %e');
    }
}

function getContactsForAddresses(device, addresses) {
    let contacts = {};

    for (let i = 0, len = addresses.length; i < len; i++) {
        let address = addresses[i].address;

        contacts[address] = device.contacts.query({
            number: address
        });
    }
}

const setAvatarVisible = function(row, visible) {
    let incoming = (row.type === Sms.MessageBox.INBOX);

    // Adjust the margins
    if (visible) {
        row.grid.margin_start = incoming ? 6 : 56;
        row.grid.margin_bottom = 6;
    } else {
        row.grid.margin_start = incoming ? 44 : 56;
        row.grid.margin_bottom = 0;
    }

    // Show hide the avatar
    if (incoming) {
        row.avatar.visible = visible;
    }
};


/**
 * A simple GtkLabel subclass with a chat bubble appearance
 */
var MessageLabel = GObject.registerClass({
    GTypeName: 'GSConnectMessageLabel'
}, class MessageLabel extends Gtk.Label {

    _init(message) {
        this.message = message;
        let incoming = (message.type === Sms.MessageBox.INBOX);

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
const ThreadRow = GObject.registerClass({
    GTypeName: 'GSConnectThreadRow'
}, class ThreadRow extends Gtk.ListBoxRow {
    _init(contacts, message) {
        super._init({visible: true});

        // Row layout
        let grid = new Gtk.Grid({
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 8,
            margin_end: 8,
            column_spacing: 8,
            visible: true
        });
        this.add(grid);

        // Contact Avatar
        this._avatar = new Contacts.Avatar(null);
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
        this._sender = message.addresses[0].address;

        // Contact Name
        let nameLabel = _('Unknown Contact');

        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this._avatar.contact = this.contacts[this._sender];
            nameLabel = this._avatar.contact.name;
        } else {
            this._avatar.contact = null;
            nameLabel = _('Group Message');
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
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/conversation.ui',
    Children: [
        'entry', 'list', 'scrolled',
        'pending', 'pending-box'
    ]
}, class ConversationWidget extends Gtk.Grid {

    _init(params) {
        this.connectTemplate();
        super._init({device: params.device});
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
        this.pending.date = Number.MAX_SAFE_INTEGER;
        this.bind_property(
            'has-pending',
            this.pending,
            'visible',
            GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE
        );

        // Message List
        this.list.set_header_func(this._headerMessages);
        this.list.set_sort_func(this._sortMessages);
        this._populateMessages();

        // HACK: This property was added in gtk-3.24; if it's not present this
        // will just become a useless JS variable instead of choking
        this.entry.enable_emoji_completion = true;

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    get addresses() {
        if (this._addresses === undefined) {
            this._addresses = [];
        }

        return this._addresses;
    }

    set addresses(addresses) {
        if (!addresses || addresses.length === 0) {
            this._addresses = [];
            this._contacts = {};
            return;
        }

        this._addresses = addresses;

        // Lookup a contact for each address object
        for (let i = 0, len = this.addresses.length; i < len; i++) {
            let address = this.addresses[i].address;

            this.contacts[address] = this.device.contacts.query({
                number: address
            });
        }
    }

    get contacts() {
        if (this._contacts === undefined) {
            this._contacts = {};
        }

        return this._contacts;
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

    get thread_id() {
        if (this._thread_id === undefined) {
            this._thread_id = null;
        }

        return this._thread_id;
    }

    set thread_id(thread_id) {
        let thread = this.sms.threads[thread_id];
        let message = (thread) ? thread[0] : null;

        if (message && this.addresses.length === 0) {
            this.addresses = message.addresses;
            this._thread_id = thread_id;
        }
    }

    _onConnected(device) {
        if (device.connected) {
            this.pending_box.foreach(msg => msg.destroy());
        }
    }

    _onDestroy(conversation) {
        conversation.disconnectTemplate();

        conversation.device.disconnect(conversation._connectedId);

        conversation.list.foreach(message => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            message.run_dispose();
            imports.system.gc();
        });
    }

    /**
     * Messages
     */
    _createMessageRow(message) {
        let incoming = (message.type === Sms.MessageBox.INBOX);

        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            visible: true
        });

        // Sort properties
        row.date = message.date;
        row.type = message.type;
        row.sender = message.addresses[0].address;

        row.grid = new Gtk.Grid({
            can_focus: false,
            hexpand: true,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: incoming ? 18 : 6,
            //margin: 6,
            column_spacing: 6,
            halign: incoming ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(row.grid);

        // Add avatar for incoming messages
        if (incoming) {
            let address = message.addresses[0].address;

            // Ensure we have a contact
            if (!this.contacts[address]) {
                this.contacts[address] = this.device.contacts.query({
                    number: address
                });
            }

            row.avatar = new Contacts.Avatar(this.contacts[address]);
            row.avatar.valign = Gtk.Align.END;
            row.grid.attach(row.avatar, 0, 0, 1, 1);
        }

        let widget = new MessageLabel(message);
        row.grid.attach(widget, 1, 0, 1, 1);

        row.show_all();

        return row;
    }

    _populateMessages() {
        this.__first = null;
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a thread_id for this number
        if (this.thread_id === null && this.addresses.length) {
            this._thread_id = this.sms.getThreadIdForAddresses(this.addresses);
        }

        // Make a copy of the thread and fill the window with messages
        if (this.sms.threads[this.thread_id]) {
            this.__messages = this.sms.threads[this.thread_id].slice(0);
            this.logPrevious();
        }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending') return;

        if (before === null) {
            setAvatarVisible(row, true);
            return;
        }

        // Add date header if the last message was more than an hour ago
        let header = row.get_header();

        if ((row.date - before.date) > GLib.TIME_SPAN_HOUR / 1000) {
            if (!header) {
                header = new Gtk.Label({visible: true});
                header.get_style_context().add_class('dim-label');
                row.set_header(header);
            }

            header.label = getTime(row.date);

            // Also show the avatar
            setAvatarVisible(row, true);

        // Or if the previous sender was the same, hide its avatar
        } else if (row.type === before.type &&
                   row.sender.equalsPhoneNumber(before.sender)) {
            setAvatarVisible(before, false);
            setAvatarVisible(row, true);

        // otherwise show the avatar
        } else {
            setAvatarVisible(row, true);
        }
    }

    _sortMessages(row1, row2) {
        return (row1.date > row2.date) ? 1 : -1;
    }

    // GtkListBox::size-allocate
    _onMessageLogged(listbox, allocation) {
        let vadj = this.scrolled.vadjustment;

        // Try loading more messages if there's room
        if (vadj.get_upper() <= vadj.get_page_size()) {
            this.logPrevious();
            this.scrolled.get_child().check_resize();

        // We've been asked to hold the position
        } else if (this.__pos) {
            vadj.set_value(vadj.get_upper() - this.__pos);
            this.__pos = 0;

        // Otherwise scroll to the bottom
        } else {
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        }
    }

    // GtkScrolledWindow::edge-reached
    _onMessageRequested(scrolled_window, pos) {
        if (pos === Gtk.PositionType.TOP) {
            this.__pos = this.scrolled.vadjustment.get_upper();
            this.logPrevious();
        }
    }

    /**
     * Log the next message in the conversation.
     *
     * @param {Object} message - A sms message object
     */
    logNext(message) {
        try {
            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                return;

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

            if (!message) return;

            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT) {
                return;
            }

            // Prepend the message
            let row = this._createMessageRow(message);
            this.list.prepend(row);
            this.list.invalidate_headers();
        } catch (e) {
            debug(e);
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
        // TODO: removed when multi-target messages are supported
        if (this.addresses.length > 1) {
            this.entry.get_style_context().add_class('error');
            return;
        }

        // Don't send empty texts
        if (!this.entry.text.trim()) return;

        // Send the message
        this.sms.sendMessage(this.addresses, entry.text);

        // Log the message as pending
        let message = new MessageLabel({
            body: entry.text,
            date: Date.now(),
            type: Sms.MessageBox.SENT
        });
        this.pending_box.add(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';
    }

    /**
     * Set the contents of the message entry
     *
     * @param {String} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.emit('move-cursor', 0, text.length, false);
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
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-window.ui',
    Children: [
        'headerbar', 'infobar',
        'thread-list', 'stack'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        this.connectTemplate();
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

        // Contacts
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device
        });
        this.stack.add_named(this.contact_chooser, 'contact-chooser');

        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Threads
        this.thread_list.set_sort_func(this._sortThreads);

        this._threadsChangedId = this.sms.connect(
            'notify::threads',
            this._onThreadsChanged.bind(this)
        );

        this._timestampThreadsId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            60,
            this._timestampThreads.bind(this)
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        this._sync();
        this._onThreadsChanged();
        this._restoreGeometry();
    }

    vfunc_delete_event(event) {
        this._saveGeometry();
        return this.hide_on_delete();
    }

    get sms() {
        if (!this._sms) {
            this._sms = this.device.lookup_plugin('sms');
        }

        return this._sms;
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
        let thread = this.sms.threads[thread_id];

        if (conversation === null) {
            if (!thread) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new ConversationWidget({
                device: this.device,
                thread_id: thread_id
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
            // Set the header bar title/subtitle
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
        window.disconnectTemplate();
        GLib.source_remove(window._timestampThreadsId);
        window.contact_chooser.disconnect(window._numberSelectedId);
        window.sms.disconnect(window._threadsChangedId);
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

        if (row) {
            this.thread_list.select_row(row);
        } else {
            this.setContacts(contacts);
        }
    }

    /**
     * Window State
     */
    _restoreGeometry() {
        if (this._mutterSettings === undefined) {
            this._mutterSettings = new Gio.Settings({
                schema_id: 'org.gnome.mutter'
            });
        }

        // Restore geometry, even if we're going to maximize
        let [width, height] = this.settings.get_value('window-size').deep_unpack();
        this.set_default_size(width, height);

        // Respect mutter's settings
        if (!this._mutterSettings.get_boolean('center-new-windows')) {
            let [x, y] = this.settings.get_value('window-position').deep_unpack();
            this.move(x, y);
        }

        // Maximize if set
        if (this.settings.get_boolean('window-maximized'))
            this.maximize();
    }

    _saveGeometry() {
        let state = this.get_window().get_state();

        // Maximized State
        let maximized = (state & Gdk.WindowState.MAXIMIZED);
        this.settings.set_boolean('window-maximized', maximized);

        // Leave the size and position at the values before maximizing
        if (maximized || (state & Gdk.WindowState.FULLSCREEN))
            return;

        // Save the size and position
        let size = this.get_size();
        this.settings.set_value('window-size', new GLib.Variant('(ii)', size));

        let position = this.get_position();
        this.settings.set_value('window-position', new GLib.Variant('(ii)', position));
    }

    /**
     * Threads
     */
    _onThreadsChanged() {
        // Get the last message in each thread
        let messages = {};

        for (let [thread_id, thread] of Object.entries(this.sms.threads)) {
            let message = thread[thread.length - 1];

            // Skip messages without a body (eg. MMS messages without text)
            if (message.body) {
                messages[thread_id] = thread[thread.length - 1];
            }
        }

        // Update existing summaries and destroy old ones
        for (let row of this.thread_list.get_children()) {
            let message = messages[row.thread_id];

            // If it's an existing conversation, update it
            if (message) {
                // Ensure there's a contact mapping
                let sender = message.addresses[0].address;

                if (!row.contacts[sender]) {
                    row.contacts[sender] = this.device.contacts.query({
                        number: sender
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
            let conversation = new ThreadRow(contacts, message);
            this.thread_list.add(conversation);
        }

        // Re-sort the summaries
        this.thread_list.invalidate_sort();
    }

    // GtkListBox::row-selected
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
            this.thread_list.foreach(row => row.update());
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for @contacts
     *
     * @param {Array of Object} contacts - A contact group
     * @return {ThreadRow|null} - The thread row or %null
     */
    _getRowForContacts(contacts) {
        let addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });

        // Try to find a thread_id
        let thread_id = this.sms.getThreadIdForAddresses(addresses);

        for (let row of this.thread_list.get_children()) {
            if (row.message.thread_id === thread_id)
                return row;
        }

        return null;
    }

    setContacts(contacts) {
        // Group the addresses
        let addresses = [];

        for (let address of Object.keys(contacts)) {
            addresses.push({address: address});
        }

        // Try to find a thread ID for this address group
        let thread_id = this.sms.getThreadIdForAddresses(addresses);

        if (thread_id === null) {
            thread_id = GLib.uuid_string_random();
        } else {
            thread_id = thread_id.toString();
        }

        // Try to find a thread row for the ID
        let row = this._getRowForContacts(contacts);

        if (row !== null) {
            this.thread_list.select_row(row);
            return;
        }

        // We're creating a new conversation
        let conversation = new ConversationWidget({
            device: this.device,
            addresses: addresses
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

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Try and find an existing conversation widget for @message.
     *
     * @param {object} message - A message object
     * @return {ConversationWidget|null} - A conversation widget or %null
     */
    getConversationForMessage(message) {
        // This shouldn't happen
        if (message === null) return null;

        // First try to find a conversation by thread_id
        let thread_id = `${message.thread_id}`;
        let conversation = this.stack.get_child_by_name(thread_id);

        if (conversation !== null) {
            return conversation;
        }

        // Try and find one by matching addresses, which is necessary if we've
        // started a thread locally and haven't set the thread_id
        let addresses = message.addresses;

        for (let conversation of this.stack.get_children()) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length) {
                continue;
            }

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
     * @param {string} text - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    setMessage(message, pending = false) {
        try {
            if (pending) {
                this._pendingShare = message;
            } else {
                this.stack.visible_child.setMessage(message);
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
        this.headerbar = new Gtk.HeaderBar({
            title: _('Share Link'),
            subtitle: this.message,
            show_close_button: true,
            tooltip_text: this.message
        });
        this.set_titlebar(this.headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true
        });
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.thread_list = new Gtk.ListBox({
            activate_on_single_click: false
        });
        this.thread_list.set_sort_func(Window.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.thread_list);

        // Filter Setup
        Window.prototype._onThreadsChanged.call(this);
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
        this.sms.window._onNewConversation();
        this.sms.window._pendingShare = message;
    }

    _select(box, row) {
        this.sms.sms();
        this.sms.window.thread_id = row.message.thread_id.toString();
        this.sms.window.setMessage(this.message);

        this.destroy();
    }
});

