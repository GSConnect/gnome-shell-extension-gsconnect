'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;


/**
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
var MessageEvent = {
    TEXT_MESSAGE: 0x1
};


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
var MessageStatus = {
    UNREAD: 0,
    READ: 1
};


/**
 * SMS Message direction. IN/OUT match the 'type' field from the Android App
 * message packet.
 *
 * NOTICE: A general message (eg. timestamp, missed call)
 * IN: An incoming message
 * OUT: An outgoing message
 */
var MessageType = {
    NOTICE: 0,
    IN: 1,
    OUT: 2
};


// http://daringfireball.net/2010/07/improved_regex_for_matching_urls
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:http|https|ftp)://' +             // scheme://
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');


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
        super._init({
            label: this._linkify(message.body),
            halign: (message.type === MessageType.IN) ? Gtk.Align.START : Gtk.Align.END,
            selectable: true,
            tooltip_text: getTime(message.date),
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0
        });

        if (message.type === MessageType.IN) {
            this.get_style_context().add_class('message-in');
        } else {
            this.get_style_context().add_class('message-out');
        }

        this.message = message;
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

    /**
     * Return a string with URLs couched in <a> tags, parseable by Pango and
     * using the same RegExp as GNOME Shell.
     *
     * @param {string} text - The string to be modified
     * @return {string} - the modified text
     */
    _linkify(text) {
        _urlRegexp.lastIndex = 0;
        text = GLib.markup_escape_text(text, -1);
        return text.replace(_urlRegexp, '$1<a href="$2">$2</a>');
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
const ConversationSummary = GObject.registerClass({
    GTypeName: 'GSConnectConversationSummary'
}, class ConversationSummary extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init();

        this.contact = contact;
        this.message = message;

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6
        });
        this.add(grid);

        let nameLabel = contact.name;
        let bodyLabel = message.body.split(/\r|\n/)[0];
        bodyLabel = '<small>' + GLib.markup_escape_text(bodyLabel, -1) + '</small>';

        if (message.read === MessageStatus.UNREAD) {
            nameLabel = '<b>' + nameLabel + '</b>';
            bodyLabel = '<b>' + bodyLabel + '</b>';
        }

        grid.attach(new Contacts.Avatar(contact), 0, 0, 1, 3);

        let name = new Gtk.Label({
            label: nameLabel,
            halign: Gtk.Align.START,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0
        });
        grid.attach(name, 1, 0, 1, 1);

        let time = new Gtk.Label({
            label: '<small>' + getShortTime(message.date) + '</small>',
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0
        });
        //time.connect('map', (widget) => {
        //    widget.label = '<small>' + getShortTime(this.message.date) + '</small>';
        //    return false;
        //});
        time.get_style_context().add_class('dim-label');
        grid.attach(time, 2, 0, 1, 1);

        let body = new Gtk.Label({
            label: bodyLabel,
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0
        });
        grid.attach(body, 1, 1, 2, 1);

        this.show_all();
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
            GObject.BindingFlags.DEFAULT
        );

        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect('notify::connected', (device) => {
            if (device.connected) {
                this.pending_box.foreach(msg => msg.destroy());
            }
        });

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
    }

    get address() {
        return this._address || null;
    }

    set address(value) {
        this._address = value;
        this._displayNumber = value;
        this._notifications = [];

        // Ensure we have a contact stored
        let contact = this.device.contacts.query({
            number: value,
            create: true
        });
        this._contact_id = contact.id;

        // See if we have a nicer display number
        let number = value.toPhoneNumber();

        for (let contactNumber of contact.numbers) {
            let cnumber = contactNumber.value.toPhoneNumber();

            if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                this._displayNumber = contactNumber.value;
                break;
            }
        }

        this.notify('address');
    }

    get contact() {
        if (this._contact_id) {
            return this.device.contacts.get_item(this._contact_id);
        }

        return null;
    }

    set contact(id) {
        let contact = this.device.contacts.get_item(id);
        this._contact_id = (contact.id) ? contact.id : null;
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
        if (!this._thread_id) {
            this._thread_id = 0;
        }

        return this._thread_id;
    }

    set thread_id(id) {
        this._thread_id = id || 0;
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation.disconnect_template();
    }

    /**
     * Messages
     */
    _populateMessages() {
        this.message_list.foreach(row => {
            if (row.get_name() !== 'pending') {
                row.destroy();
            }
        });

        this.__first = null;
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a conversation for this number
        let number = this.address.toPhoneNumber();

        for (let thread of Object.values(this.sms.conversations)) {
            let tnumber = thread[0].address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                this.thread_id = thread[0].thread_id;
                break;
            }
        }

        if (this.sms.conversations[this.thread_id]) {
            this.__messages = this.sms.conversations[this.thread_id].slice(0);
            this._populateBack();
        }
    }

    _populateBack() {
        for (let i = 0; i < 5 && this.__messages.length; i++) {
            this.logMessage(this.__messages.pop());
        }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending') return;

        // Check if the last series was more than an hour ago
        // TODO: headers between series will require "real" message rows
        if (before && (row.date - before.date) > GLib.TIME_SPAN_HOUR / 1000) {
            let header = new Gtk.Label({
                label: '<small>' + getTime(row.date) + '</small>',
                halign: Gtk.Align.CENTER,
                hexpand: true,
                use_markup: true,
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
        // Skip if there's no thread defined
        if (this.thread_id === 0) {
            return;
        }

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
        if (pos === Gtk.PositionType.TOP && this.thread_id) {
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
            halign: (row.type === MessageType.IN) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(layout);

        // Add avatar for incoming messages
        if (row.type === MessageType.IN) {
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
            margin_right: (row.type === MessageType.IN) ? 44 : 0,
            margin_left: (row.type === MessageType.IN) ? 0 : 44
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
        // Start a new series if this is the first
        if (!this.__first) {
            this.__first = this._createSeries(message);
            this.__last = this.__first;
            this.message_list.add(this.__first);
        }

        // Log the message and set the thread date
        let widget = new ConversationMessage(message);

        // If this is the earliest message so far...
        if (message._id <= this.__first.id) {
            // ...and it's in a different direction, create a new series
            if (message.type !== this.__first.type) {
                this.__first = this._createSeries(message);
                this.message_list.prepend(this.__first);
            }

            // ...and prepend it
            this.__first.id = message._id;
            this.__first.messages.pack_end(widget, false, false, 0);

        // Or if it's older than the last message...
        } else {
            // ...and it's in a different direction, create a new series
            if (message.type !== this.__last.type) {
                this.__last = this._createSeries(message);
                this.message_list.add(this.__last);
            }

            // ...and append it
            this.__last.id = message._id;
            this.__last.messages.add(widget);

            // Remove the first pending message
            if (this.has_pending && message.type === MessageType.OUT) {
                this.pending_box.get_children()[0].destroy();
                this.notify('has-pending');
            }
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
        if (!this.message_entry.text) return;

        // Send the message
        this.device.activate_action(
            'sendSms',
            new GLib.Variant('(ss)', [this.address, entry.text])
        );

        // Log the message as pending
        let message = new ConversationMessage({
            body: entry.text,
            date: Date.now(),
            type: MessageType.OUT
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
            this._populateConversations.bind(this)
        );

        // Conversations Placeholder
        this.conversation_list.set_placeholder(this.conversation_list_placeholder);

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        this._sync();
        this._populateConversations();
    }

    vfunc_delete_event(event) {
        this.save_geometry();
        this.hide();

        return true;
    }

    get address() {
        return this.conversation_stack.visible_child_name;
    }

    set address(value) {
        if (!value) {
            this.conversation_list.select_row(null);
            this.conversation_stack.set_visible_child_name('placeholder');
            return;
        }

        // Ensure we have a contact stored and hold a reference to it
        let contact = this.device.contacts.query({
            number: value,
            create: true
        });
        this._contact = contact;

        this.headerbar.title = contact.name;
        this.headerbar.subtitle = value;

        // See if we have a nicer display number
        let number = value.toPhoneNumber();

        for (let contactNumber of contact.numbers) {
            let cnumber = contactNumber.value.toPhoneNumber();

            if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                this.headerbar.subtitle = contactNumber.value;
                break;
            }
        }

        // Create a conversation widget if there isn't one
        let conversation = this.conversation_stack.get_child_by_name(number);

        if (conversation === null) {
            conversation = new ConversationWidget({
                device: this.device,
                address: number
            });

            this.conversation_stack.add_named(conversation, number);
        }

        this.conversation_stack.set_visible_child_name(number);

        // There was a pending message waiting for a contact to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = undefined;
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
            this.device.contacts.clear(true);
            contacts.connected();
        } else {
            this.device.contacts._loadFolks();
        }

        // SMS history
        this.sms.connected();
    }

    _onDestroy(window) {
        window.contact_list.disconnect(window._numberSelectedId);
        window.sms.disconnect(window._conversationsChangedId);
        window.disconnect_template();
    }

    _onNewConversation() {
        this._sync();
        this.conversation_stack.set_visible_child_name('contact-list');
    }

    _onNumberSelected(list, number) {
        number = number.toPhoneNumber();

        for (let row of this.conversation_list.get_children()) {
            if (!row.message) continue;

            let cnumber = row.message.address.toPhoneNumber();

            if (cnumber.endsWith(number) || number.endsWith(cnumber)) {
                this.conversation_list.select_row(row);
                return;
            }
        }

        this.conversation_list.select_row(null);
        this.address = number;
    }

    /**
     * Conversations
     */
    _populateConversations() {
        this.conversation_list.foreach(row => row.destroy());

        for (let thread of Object.values(this.sms.conversations)) {
            let contact = this.device.contacts.query({
                number: thread[0].address
            });

            this.conversation_list.add(
                new ConversationSummary(contact, thread[thread.length - 1])
            );
        }
    }

    _sortConversations(row1, row2) {
        return (row1.message.date > row2.message.date) ? -1 : 1;
    }

    _onConversationSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.address = row.message.address;
            this.conversation_stack.visible_child.message_entry.has_focus = true;

        // Show the placeholder
        } else {
            this.headerbar.title = _('Messaging');
            this.headerbar.subtitle = this.device.name;
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
            tooltip_text: _('New Message'),
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

        let conversation = this.sms._hasConversation(row.message.address);
        conversation.setMessage(this.message);
        this.destroy();
    }
});

