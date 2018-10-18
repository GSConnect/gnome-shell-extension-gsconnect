'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;


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
    time = GLib.DateTime.new_from_unix_local(time/1000);
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
            return _('%d minutes').format(diff/GLib.TIME_SPAN_MINUTE);

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
    time = GLib.DateTime.new_from_unix_local(time/1000);
    let diff = GLib.DateTime.new_now_local().difference(time);

    switch (true) {
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return _('%d minutes').format(diff/GLib.TIME_SPAN_MINUTE);

        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return time.format('%a');

        default:
            return time.format('%b %e');
    }
}


/**
 * A convenience function to prepare a string for Pango markup
 */
String.prototype.toPango = function() {
    return this.replace(/&(?!amp;)/g, '&amp;');
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
        return text.replace(
            _urlRegexp,
            '$1<a href="$2">$2</a>'
        ).toPango();
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
var ConversationSummary = GObject.registerClass({
    GTypeName: 'GSConnectConversationSummary'
}, class ConversationSummary extends Gtk.ListBoxRow {
    _init(contact, message) {
        super._init({ visible: true });

        this.contact = contact;
        this.message = message;

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        this.add(grid);

        let nameLabel = contact.name;
        let bodyLabel = message.body.split(/\r|\n/)[0].toPango();
        bodyLabel = '<small>' + bodyLabel + '</small>';

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
            xalign: 0,
            visible: true
        });
        grid.attach(name, 1, 0, 1, 1);

        let time = new Gtk.Label({
            label: '<small>' + getShortTime(message.date) + '</small>',
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
//        time.connect('map', (widget) => {
//            widget.label = '<small>' + getShortTime(this.message.date) + '</small>';
//            return false;
//        });
        time.get_style_context().add_class('dim-label');
        grid.attach(time, 2, 0, 1, 1);

        let body = new Gtk.Label({
            label: bodyLabel,
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(body, 1, 1, 2, 1);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = GObject.registerClass({
    GTypeName: 'GSConnectConversationWindow',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'address': GObject.ParamSpec.string(
            'address',
            'Address',
            'The target phone number or other address',
            GObject.ParamFlags.READWRITE,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/conversation-window.ui',
    Children: [
        'headerbar', 'infobar', 'stack',
        'go-previous',
        'conversation-window', 'conversation-list', 'conversation-add',
        'message-window', 'message-list', 'message-entry'
    ]
}, class ConversationWindow extends Gtk.ApplicationWindow {

    _init(params) {
        this.connect_template();
        super._init(params);

        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup('org.gnome.Shell.Extensions.GSConnect.Messaging', true),
            path: '/org/gnome/shell/extensions/gsconnect/messaging/'
        });

        this.insert_action_group('device', this.device);

        // Convenience actions for syncing Contacts/SMS from the menu
        if (this.device.get_outgoing_supported('contacts.response_vcards')) {
            let sync_contacts = new Gio.SimpleAction({ name: 'sync-contacts' });
            sync_contacts.connect('activate', () => this.device.lookup_plugin('contacts').connected());
            this.add_action(sync_contacts);
        }

        if (this.device.get_outgoing_supported('sms.messages')) {
            let sync_messages = new Gio.SimpleAction({ name: 'sync-messages' });
            sync_messages.connect('activate', () => this.device.lookup_plugin('sms').connected());
            this.add_action(sync_messages);
        }

        // Conversations
        this.conversation_list.set_sort_func(this._sortConversations);
        this.message_list.set_header_func(this._headerMessages);

        // Contacts
        this.contact_list = new Contacts.ContactChooser({
            store: this.device.contacts
        });
        this._selectedNumbersChangedId = this.contact_list.connect(
            'notify::selected',
            this._onSelectedNumbersChanged.bind(this)
        );
        this.stack.add_named(this.contact_list, 'contacts');
        this.stack.child_set_property(this.contact_list, 'position', 1);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        this.device.bind_property(
            'connected',
            this.message_entry,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        // Set the default view
        this._ready = true;
        (this.address) ? this._showMessages() : this._showPrevious();
        this.restore_geometry();
    }

    vfunc_delete_event(event) {
        this.disconnect_template();
        this.save_geometry();

        this.contact_list.disconnect(this._selectedNumbersChangedId);
        this.contact_list._destroy();

        return false;
    }

    get address() {
        return this._address || null;
    }

    set address(value) {
        if (value) {
            this._address = value;
            this._displayNumber = value;
            this._notifications = [];

            // Ensure we have a contact stored
            let contact = this.device.contacts.query({
                number: value,
                create: true
            });
            this._contact = contact.id;

            // See if we have a nicer display number
            let number = value.toPhoneNumber();

            for (let contactNumber of contact.numbers) {
                let cnumber = contactNumber.value.toPhoneNumber();

                if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                    this._displayNumber = contactNumber.value;
                    break;
                }
            }

            if (this._ready) {
                this._showMessages();
            }
        } else {
            this._address = null;
            this._contact = null;
            this._displayNumber = null;
        }

        this.notify('address');
    }

    get contact() {
        if (this._contact) {
            return this.device.contacts.get_item(this._contact);
        }

        return null;
    }

    set contact(id) {
        let contact = this.device.contacts.get_item(id);
        this._contact = (contact.id) ? contact.id : null;
    }

    get has_conversations() {
        return (this.sms && Object.keys(this.sms.conversations).length);
    }

    get message_id() {
        if (!this._message_id) {
            this._message_id = 0;
        }

        return this._message_id;
    }

    set message_id(id) {
        this._message_id = id || 0;
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

    /**
     * View selection
     */
    _showContacts() {
        this.conversation_add.visible = false;
        this.go_previous.visible = this.has_conversations;

        this.headerbar.custom_title = this.contact_list.entry;
        this.contact_list.entry.has_focus = true;
        this.stack.set_visible_child_name('contacts');
    }

    _showConversations() {
        this.conversation_add.visible = true;
        this.go_previous.visible = false;

        this.contact_list.entry.text = '';
        this.headerbar.custom_title = null;

        this.headerbar.title = _('Conversations');
        this.headerbar.subtitle = this.device.name;
        this.stack.set_visible_child_name('conversations');

        this._populateConversations();
    }

    _showMessages() {
        this.conversation_add.visible = false;
        this.go_previous.visible = true;

        this.contact_list.entry.text = '';
        this.headerbar.custom_title = null;

        let contact = this.contact;
        this.headerbar.title = (contact.name) ? contact.name : this._displayNumber;
        this.headerbar.subtitle = (contact.name) ? this._displayNumber : null;

        this.message_entry.has_focus = true;
        this.stack.set_visible_child_name('messages');

        this._populateMessages();
    }

    _showPrevious() {
        this.contact_list.reset();
        this.message_list.foreach(row => row.destroy());

        this.address = null;
        this.message_id = 0;
        this.thread_id = 0;

        // Show the contact list if there are no conversations
        if (this.has_conversations) {
            this._showConversations();
        } else {
            this._showContacts();
        }
    }

    /**
     * Conversations
     */
    _populateConversations() {
        this.conversation_list.foreach(row => row.destroy());

        if (this.has_conversations) {
            for (let thread of Object.values(this.sms.conversations)) {
                try {
                    let contact = this.device.contacts.query({
                        number: thread[0].address
                    });

                    this.conversation_list.add(
                        new ConversationSummary(contact, thread[thread.length-1])
                    );
                } catch (e) {
                    logError(e);
                }
            }

            this.go_previous.visible = (this.stack.visible_child_name !== 'conversations');
        } else {
            this.go_previous.visible = false;
        }
    }

    _sortConversations(row1, row2) {
        return (row1.message.date > row2.message.date) ? -1 : 1;
    }

    _onConversationActivated(box, row) {
        this.address = row.message.address;
    }

    /**
     * Messages
     */
    _populateMessages() {
        this.message_list.foreach(row => row.destroy());

        this.__first = null
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a conversation for this number
        let number = this.address.toPhoneNumber();

        if (this.has_conversations) {
            for (let thread of Object.values(this.sms.conversations)) {
                let tnumber = thread[0].address.toPhoneNumber();

                if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                    this.thread_id = thread[0].thread_id;
                    break;
                }
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
        // ...check if the last message was more than an hour ago
        if (before && (row.date - before.date) > GLib.TIME_SPAN_HOUR/1000) {
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
    }

    // message-window::edge-overshot
    _onMessageRequested(scrolled_window, pos) {
        if (pos === Gtk.PositionType.TOP && this.thread_id) {
            this.__pos = this.message_window.vadjustment.get_upper();
            this._populateBack();
        }
    }

    /**
     * Search Entry
     */
    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onEntryFocused(entry) {
        if (entry.has_focus) {
            let notification = this.device.lookup_plugin('notification');

            if (notification) {
                while (this._notifications.length > 0) {
                    notification.closeNotification(this._notifications.pop());
                }
            }
        }
    }

    _onSelectedNumbersChanged(contact_list) {
        if (this.contact_list.selected.length > 0) {
            this.address = this.contact_list.selected[0];
        }
    }

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
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
            margin_left: (row.type === MessageType.IN) ? 0: 44
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
            this.message_id = message._id
            this.message_list.add(this.__first);
        }

        // Log the message and set the thread date
        let widget = new ConversationMessage(message);

        // If this is the earliest message so far prepend it
        if (message.date <= this.__first.date) {
            if (message.type !== this.__first.type) {
                this.__first = this._createSeries(message);
                this.message_list.prepend(this.__first);
            }

            this.__first.messages.pack_end(widget, false, false, 0);
            this.__first.date = message.date;

        // Or append it if it's newer than the last known
        } else if (message.date > this.__last.date) {
            if (message.type !== this.__last.type) {
                this.__last = this._createSeries(message);
                this.message_list.add(this.__last);
            }

            if (this.message_id !== message._id) {
                this.__last.messages.pack_start(widget, false, false, 0);
                this.__last.date = message.date;
                this.message_id = message._id
            } else {
                let messages = this.__last.messages.get_children();
                messages[messages.length - 1].opacity = 1.0;
            }
        }
    }

    /**
     * Log an incoming message in the MessageList
     * TODO: this is being deprecated by 'kdeconnect.sms.message', but we
     *       keep it for now so the sms plugin can use it to fake support.
     *
     * @param {Object} message - A sms message object
     */
    receiveMessage(message) {
        this.address = message.address;

        // Log an incoming telepony message (fabricated by the sms plugin)
        this.logMessage({
            _id: this.message_id + 1,
            thread_id: this.thread_id,
            address: message.address,
            body: message.body,
            date: message.date,
            event: 'sms',
            read: MessageStatus.UNREAD,
            type: MessageType.IN
        });
    }

    /**
     * Send the contents of the message entry to the address
     */
    sendMessage(entry, signal_id, event) {
        // Ensure the action is enabled so we don't log messages without sending
        if (this.device.get_action_enabled('sendSms')) {
            this.device.activate_action(
                'sendSms',
                new GLib.Variant('(ss)', [this.address, entry.text])
            );

            // Log the outgoing message as a fabricated message packet
            this.logMessage({
                _id: this.message_id + 1,
                thread_id: this.thread_id,
                address: this.address,
                body: entry.text,
                date: Date.now(),
                event: 'sms',
                read: MessageStatus.READ,
                type: MessageType.OUT
            });

            // If supported, fade the message until we receive confirmation
            if (this.device.get_outgoing_supported('sms.messages')) {
                let messages = this.__last.messages.get_children();
                messages[messages.length - 1].opacity = 0.5;
            }

            // Clear the entry
            this.message_entry.text = '';
        }
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
            subtitle: url,
            show_close_button: true,
            tooltip_text: url
        });
        this.set_titlebar(headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({ icon_name: 'list-add-symbolic' }),
            tooltip_text: _('New Message'),
            always_show_image: true
        });
        newButton.connect('clicked', () => {
            let window = new ConversationWindow(this.device);
            window.setMessage(url);
            this.destroy();
            window.present();
        });
        headerbar.pack_start(newButton);

        // Conversations
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect('row-activated', (list, row) => this._select(row.window_));
        this.list.connect('selected-rows-changed', () => {
            // TODO: not a button anymore
            sendButton.sensitive = (this.list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        // Filter Setup
        this.show_all();
        this._addWindows();
    }

    _select(window) {
        window.setMessage(this.message);
        this.destroy();
        window.present();
    }

    _addWindows() {
        for (let window of Gio.Application.get_default().get_windows()) {
            if (window.address && window.device === this.device) {
                let row = new Gtk.ListBoxRow();
                this.list.add(row);

                let grid = new Gtk.Grid({
                    margin: 6,
                    column_spacing: 6
                });
                row.add(grid);

                let avatar = new Contacts.Avatar(window.contact);
                grid.attach(avatar, 0, 0, 1, 2);

                let name = new Gtk.Label({
                    label: window.contact.name,
                    halign: Gtk.Align.START
                });
                grid.attach(name, 1, 0, 1, 1);

                let number = new Gtk.Label({
                    label: window.address,
                    halign: Gtk.Align.START
                });
                number.get_style_context().add_class('dim-label');
                grid.attach(number, 1, 1, 1, 1);

                row.window_ = window;
                row.show_all();
            }
        }
    }
});

