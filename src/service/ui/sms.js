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
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces.
 * This allows passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
let _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
let _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
let _lenientDigits = "[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+";
let _lenientNumber = _lenientDigits + "(?:" + _telParam + ")*";

var _smsRegex = new RegExp(
    "^" +
    "sms:" +                                // scheme
    "(?:[/]{2,3})?" +                       // Gio.File returns ":///"
    "(" +                                   // one or more...
        _lenientNumber +                    // phone numbers
        "(?:," + _lenientNumber + ")*" +    // separated by commas
    ")" +
    "(?:\\?(" +                             // followed by optional...
        _smsParam +                         // parameters...
        "(?:&" + _smsParam + ")*" +         // separated by "&" (unescaped)
    "))?" +
    "$", "g");                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    "^" +
    "(" + _lenientDigits + ")" +            // phone number digits
    "((?:" + _telParam + ")*)" +            // followed by optional parameters
    "$", "g");


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var URI = class URI {
    constructor(uri) {
        debug('Sms.URI: _init(' + uri + ')');

        let full, recipients, query;

        try {
            _smsRegex.lastIndex = 0;
            [full, recipients, query] = _smsRegex.exec(uri);
        } catch (e) {
            throw URIError('malformed sms URI');
        }

        this.recipients = recipients.split(',').map(recipient => {
            _numberRegex.lastIndex = 0;
            let [full, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(';')) {
                    let [key, value] = param.split('=');

                    // add phone-context to beginning of
                    if (key === 'phone-context' && value.startsWith('+')) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split('&')) {
                let [key, value] = field.split('=');

                if (key === 'body') {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    }

    toString() {
        let uri = 'sms:' + this.recipients.join(',');

        return (this.body) ? uri + '?body=' + escape(this.body) : uri;
    }
}


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
        // Super recent
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        // Under an hour
        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return _('%d minutes').format(diff/GLib.TIME_SPAN_MINUTE);

        // Less than a week ago
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
            (uri.indexOf('://') < 0) ? 'http://' + uri : uri,
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
     * using the same RegExp as Gnome Shell.
     *
     * @param {string} text - The string to be modified
     * @return {string} - the modified text
     */
    _linkify(text) {
        _urlRegexp.lastIndex = 0;
        return text.replace(
            _urlRegexp,
            '$1<a href="$2">$2</a>'
        ).replace(
            /&(?!amp;)/g,
            '&amp;'
        );
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
        let bodyLabel = '<small>' + message.body + '</small>';

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


var ConversationWidget = GObject.registerClass({
    GTypeName: 'GSConnectConversationWidget',
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'deviceConnected',
            'Whether the device is connected',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'device': GObject.ParamSpec.object(
            'device',
            'WindowDevice',
            'The device associated with this window',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'number': GObject.ParamSpec.string(
            'number',
            'RecipientPhoneNumber',
            'The conversation recipient phone number',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'message-id': GObject.ParamSpec.uint(
            'message-id',
            'Message ID',
            'The ID of the last message of the current conversation thread',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXINT32,
            null
        ),
        'thread-id': GObject.ParamSpec.uint(
            'thread-id',
            'Thread ID',
            'The ID of the current conversation thread',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXINT32,
            null
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/conversation-widget.ui',
    Children: [ 'message-window', 'message-list', 'message-entry' ]
}, class ConversationWidget extends Gtk.Grid {

    _init(params) {
        this.connect_template();
        super._init({ visible: true });
        Object.assign(this, params);

        this.show_all();
    }

//    get device() {
//        return this._device;
//    }

    get number() {
        if (this._number === undefined) {
            return null;
        }

        return this._number;
    }

    get recipient() {
        if (this._recipient === undefined) {
            return null;
        }

        return this._recipient;
    }

    get message_id() {
        if (this._message_id === undefined) {
            this._message_id = 0;
        }

        return this._message_id;
    }

    set message_id(id) {
        this._message_id = id;
        this.notify('message-id');
    }

    get thread_id() {
        if (this._thread_id === undefined) {
            this._thread_id = 0;
        }

        return this._thread_id;
    }

    set thread_id(id) {
        this._thread_id = id;
        this.notify('thread-id');
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onEntryHasFocus(entry) {
        while (this._notifications.length > 0) {
            this.device.hideNotification(this._notifications.pop());
        }
    }

    _onMessageLogged(listbox) {
        let vadj = this.message_window.get_vadjustment();
        vadj.set_value(vadj.get_upper() - vadj.get_page_size());
    }

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {MessageType} direction - The direction of the message
     */
    _addThread(direction) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true
        });
        row.direction = direction;
        this.message_list.add(row);

        let layout = new Gtk.Box({
            can_focus: false,
            hexpand: true,
            margin: 6,
            spacing: 6,
            halign: (direction === MessageType.IN) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(layout);

        // Add avatar for incoming messages
        if (direction === MessageType.IN) {
            let avatar = new Contacts.Avatar(this.recipient);
            avatar.valign = Gtk.Align.END;
            layout.add(avatar);
        }

        // Messages
        row.messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: layout.halign,
            // Avatar width (32px) + layout spacing (6px) + 6px
            margin_right: (direction === MessageType.IN) ? 44 : 0,
            margin_left: (direction === MessageType.IN) ? 0: 44
        });
        layout.add(row.messages);

        this._thread = row;
        this._thread.show_all();
    }

    /**
     * Log a new message in the conversation
     *
     * @param {Object} message - A telephony message object
     */
    async _addMessage(message) {
        // Check if we need a new thread
        if (this._thread === undefined) {
            this._addThread(message.type);
        }

        // If the current thread is dated...
        if (this._thread.date !== undefined) {
            // ...check if the last message was more than an hour ago
            if ((message.date - this._thread.date) > GLib.TIME_SPAN_HOUR/1000) {
                let row = new Gtk.ListBoxRow({
                    activatable: false,
                    selectable: false,
                    visible: true
                });
                this.message_list.add(row);

                let label = new Gtk.Label({
                    label: '<small>' + getTime(message.date) + '</small>',
                    halign: Gtk.Align.CENTER,
                    hexpand: true,
                    use_markup: true,
                    visible: true
                });
                label.get_style_context().add_class('dim-label');
                row.add(label);

                // Now start a new thread
                this._addThread(message.type);
            }
        }

        // Start a new thread if the message is from a different direction
        if (this._thread.direction !== message.type) {
            this._addThread(message.type)
        }

        // Log the message and set the thread date
        let conversationMessage = new ConversationMessage(message);
        this._thread.messages.add(conversationMessage);
        this._thread.date = message.date;
    }

    /**
     * Populate the message list with the messages from the thread for @number
     * TODO: number matching could be wrong
     *
     * @param {String} number - Phone number reported by KDE Connect (stripped)
     */
    async _populateMessages(number) {
        try {
            this.message_list.foreach(row => row.destroy());
            this._thread = undefined;

            let telephony = this.device.lookup_plugin('telephony');

            if (telephony.conversations.hasOwnProperty(number)) {
                let conversation = telephony.conversations[number];

                for (let message of conversation) {
                    await this._addMessage(message);
                }
                //conversation.map(message => this._addMessage(message));

                let lastMessage = conversation[conversation.length - 1];
                this._thread_id = lastMessage.thread_id;
                this._message_id = lastMessage._id;
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Log an incoming message in the MessageList
     * TODO: this is being deprecated by 'kdeconnect.telephony.message', but we
     *       keep it for now so the telephony plugin can use it to fake support.
     *
     * @param {Object} contact - A contact object for this message
     * @param {Object} message - A telephony message object
     */
    receiveMessage(contact, message) {
        this._number = message.address;

        if (!this.recipient) {
            this.setRecipient(contact, message.address);
        }

        // Log an incoming telepony message (fabricated by the telephony plugin)
        this._addMessage({
            _id: ++this.message_id,     // message id (increment as we fetch)
            thread_id: this.thread_id,  // conversation id
            address: message.address,   // always the outgoing number
            body: message.body,
            date: message.date,
            event: 'sms',
            read: MessageStatus.UNREAD,
            type: MessageType.IN,
        });
    }

    /**
     * Send the contents of the message entry to the recipient
     */
    sendMessage(entry, signal_id, event) {
        // Ensure the action is enabled so we don't log messages without sending
        if (this.device.get_action_enabled('sendSms')) {
            this.device.activate_action(
                'sendSms',
                new GLib.Variant('(ss)', [this.number, entry.text])
            );

            // Log the outgoing message as a fabricated message packet
            this._addMessage({
                _id: ++this.message_id,    // message id (increment as we fetch)
                thread_id: this.thread_id,  // conversation id
                address: this.number,       // always the outgoing number?
                body: entry.text,
                date: Date.now(),
                event: 'sms',
                read: MessageStatus.READ,
                type: MessageType.OUT,
            });

            // Clear the entry
            this.message_entry.text = '';
        }
    }

    /**
     * Set the contents of the message entry and place the cursor at the end
     *
     * @param {String} text - The message to place in the entry
     */
    setMessage(text) {
        this.message_entry.text = text;
        this.message_entry.emit('move-cursor', 0, text.length, false);
    }

    /**
     * Set the conversation recipient
     *
     * @param {Object} contact - A contact object for the message
     * @param {String} phoneNumber - The phone number (provided by Android)
     */
    setRecipient(contact, phoneNumber) {
        this._number = phoneNumber;
        this._displayNumber = phoneNumber;
        this._recipient = contact;

        // See if we have a nicer display number
        let strippedNumber = phoneNumber.replace(/\D/g, '');

        for (let contactNumber of contact.numbers) {
            if (strippedNumber === contactNumber.number.replace(/\D/g, '')) {
                this._displayNumber = contactNumber.number;
                break;
            }
        }

        // Populate the conversation
        this._populateMessages(strippedNumber);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = GObject.registerClass({
    GTypeName: 'GSConnectConversationWindow',
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'deviceConnected',
            'Whether the device is connected',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'device': GObject.ParamSpec.object(
            'device',
            'WindowDevice',
            'The device associated with this window',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'number': GObject.ParamSpec.string(
            'number',
            'RecipientPhoneNumber',
            'The conversation recipient phone number',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'message-id': GObject.ParamSpec.uint(
            'message-id',
            'Message ID',
            'The ID of the last message of the current conversation thread',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXINT32,
            null
        ),
        'thread-id': GObject.ParamSpec.uint(
            'thread-id',
            'Thread ID',
            'The ID of the current conversation thread',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXINT32,
            null
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/conversation-window.ui',
    Children: [
        'headerbar',
        'overlay',
        'info-box', 'info-button', 'info-label',
        'stack',
        'go-previous',
        'conversation-window', 'conversation-list', 'conversation-add',
        'message-window', 'message-list', 'message-entry'
    ]
}, class ConversationWindow extends Gtk.ApplicationWindow {

    _init(device) {
        this.connect_template();

        super._init({
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 300,
            urgency_hint: true
        });

        this._device = device;
        this.insert_action_group('device', device);

        // We track the local id's of remote telephony notifications so we can
        // withdraw them locally (thus closing them remotely) when focused.
        this._notifications = [];

        // TRANSLATORS: eg. Google Pixel is disconnected
        this.info_label.label = _('%s is disconnected').format(this.device.name);

        // Conversations
        this.conversation_list.set_sort_func(this._sortConversations);

        // Contacts
        this.contact_list = new Contacts.ContactChooser();
        this._selectedNumbersChangedId = this.contact_list.connect(
            'selected-numbers-changed',
            this._onSelectedNumbersChanged.bind(this)
        );
        this.stack.add_named(this.contact_list, 'contacts');
        this.stack.child_set_property(this.contact_list, 'position', 1);

        // Device Status
        this.device.bind_property(
            'connected', this, 'connected', GObject.BindingFlags.SYNC_CREATE
        );
        this.overlay.remove(this.info_box);

        // Set the default view
        this._showPrevious();
    }

    get device() {
        return this._device;
    }

    get number() {
        if (this._number === undefined) {
            return null;
        }

        return this._number;
    }

    get recipient() {
        if (this._recipient === undefined) {
            return null;
        }

        return this._recipient;
    }

    get message_id() {
        if (this._message_id === undefined) {
            this._message_id = 0;
        }

        return this._message_id;
    }

    set message_id(id) {
        this._message_id = id;
        this.notify('message-id');
    }

    get thread_id() {
        if (this._thread_id === undefined) {
            this._thread_id = 0;
        }

        return this._thread_id;
    }

    set thread_id(id) {
        this._thread_id = id;
        this.notify('thread-id');
    }

    _onDeleteEvent(window, event) {
        this.disconnect_template();

        this.contact_list._destroy();
        this.contact_list.disconnect(this._selectedNumbersChangedId);

        return false;
    }

    /**
     * View selection
     */
    _showContacts() {
        this.conversation_add.visible = false;
        this.go_previous.visible = true;

        this.headerbar.custom_title = this.contact_list.entry;
        this.contact_list.entry.has_focus = true;
        this.stack.set_visible_child_name('contacts');
    }

    _showConversations() {
        this.conversation_add.visible = true;
        this.go_previous.visible = false;

        this._populateConversations();

        this.contact_list.entry.text = '';
        this.headerbar.custom_title = null;

        this.headerbar.title = _('Conversations');
        this.headerbar.subtitle = this.device.name;
        this.stack.set_visible_child_name('conversations');
    }

    _showMessages() {
        this.conversation_add.visible = false;
        this.go_previous.visible = true;

        this.contact_list.entry.text = '';
        this.headerbar.custom_title = null;

        if (this.recipient.name) {
            this.headerbar.title = this.recipient.name;
            this.headerbar.subtitle = this._displayNumber;
        } else {
            this.headerbar.title = this._displayNumber;
            this.headerbar.subtitle = null;
        }

        this.message_entry.has_focus = true;
        this.stack.set_visible_child_name('messages');
    }

    _showPrevious() {
        this.contact_list.reset();

        let telephony = this.device.lookup_plugin('telephony');

        // Show the contact list if there are no conversations
        if (!telephony || telephony.threads.length === 0) {
            this._showContacts();
        } else {
            this._showConversations();
        }
    }

    /**
     * "Disconnected" overlay
     */
    _onConnected(window) {
        let children = this.overlay.get_children();

        // If disconnected, add the info box before revealing
        if (!this.connected && !children.includes(this.info_box)) {
            this.overlay.add_overlay(this.info_box);
        }

        this.conversation_add.sensitive = this.connected;
        this.contact_list.entry.sensitive = this.connected;
        this.go_previous.sensitive = this.connected;

        this.stack.opacity = this.connected ? 1 : 0.3;
        this.info_box.reveal_child = !this.connected;
    }

    _onRevealed(revealer) {
        let children = this.overlay.get_children();

        // If connected, remove the info box after revealing
        if (this.connected && children.includes(this.info_box)) {
            this.overlay.remove(this.info_box);
        }
    }

    /**
     * Conversation List
     */
    async _populateConversations() {
        // Clear any current threads
        this.conversation_list.foreach(row => row.destroy());

        // Populate the new threads
        let telephony = this.device.lookup_plugin('telephony');

        for (let message of telephony.threads) {
            // Ensure we have a contact for each thread
            let contact = this.contact_list.contacts.query({
                name: message.address,
                number: message.address,
                single: true,
                create: true
            });

            // Create a summary row and add it to the list
            let summary = new ConversationSummary(contact, message);
            this.conversation_list.add(summary);
        }
    }

    _sortConversations(row1, row2) {
        return (row1.message.date > row2.message.date) ? -1 : 1;
    }

    _onConversationActivated(box, row) {
        this.setRecipient(row.contact, row.message.address);
    }

    /**
     * Message List
     */

    /**
     * Populate the message list with the messages from the thread for @number
     *
     * @param {String} number - Phone number reported by KDE Connect (stripped)
     */
    async _populateMessages(number) {
        this.message_list.foreach(row => row.destroy());
        this._thread = undefined;

        let telephony = this.device.lookup_plugin('telephony');

        if (telephony.conversations.hasOwnProperty(number)) {
            let conversation = telephony.conversations[number];
            conversation.map(message => this._addMessage(message));

            let lastMessage = conversation[conversation.length - 1];
            this._thread_id = lastMessage.thread_id;
            this._message_id = lastMessage._id;
        }
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onEntryHasFocus(entry) {
        while (this._notifications.length > 0) {
            this.device.hideNotification(this._notifications.pop());
        }
    }

    _onMessageLogged(listbox) {
        let vadj = this.message_window.get_vadjustment();
        vadj.set_value(vadj.get_upper() - vadj.get_page_size());
    }

    // TODO: this is kind of awkward...
    _onSelectedNumbersChanged(contact_list) {
        if (this.contact_list.selected.size > 0) {
            let number = this.contact_list.selected.keys().next().value;
            this.setRecipient(this.contact_list.selected.get(number), number);
        }
    }

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {MessageType} direction - The direction of the message
     */
    _addThread(direction) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true
        });
        row.direction = direction;
        this.message_list.add(row);

        let layout = new Gtk.Box({
            can_focus: false,
            hexpand: true,
            margin: 6,
            spacing: 6,
            halign: (direction === MessageType.IN) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(layout);

        // Add avatar for incoming messages
        if (direction === MessageType.IN) {
            let avatar = new Contacts.Avatar(this.recipient);
            avatar.valign = Gtk.Align.END;
            layout.add(avatar);
        }

        // Messages
        row.messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: layout.halign,
            // Avatar width (32px) + layout spacing (6px) + 6px
            margin_right: (direction === MessageType.IN) ? 44 : 0,
            margin_left: (direction === MessageType.IN) ? 0: 44
        });
        layout.add(row.messages);

        this._thread = row;
        this._thread.show_all();
    }

    /**
     * Log a new message in the conversation
     *
     * @param {Object} message - A telephony message object
     */
    async _addMessage(message) {
        // Check if we need a new thread
        if (this._thread === undefined) {
            this._addThread(message.type);
        }

        // If the current thread is dated...
        if (this._thread.date !== undefined) {
            // ...check if the last message was more than an hour ago
            if ((message.date - this._thread.date) > GLib.TIME_SPAN_HOUR/1000) {
                let row = new Gtk.ListBoxRow({
                    activatable: false,
                    selectable: false,
                    visible: true
                });
                this.message_list.add(row);

                let label = new Gtk.Label({
                    label: '<small>' + getTime(message.date) + '</small>',
                    halign: Gtk.Align.CENTER,
                    hexpand: true,
                    use_markup: true,
                    visible: true
                });
                label.get_style_context().add_class('dim-label');
                row.add(label);

                // Now start a new thread
                this._addThread(message.type);
            }
        }

        // Start a new thread if the message is from a different direction
        if (this._thread.direction !== message.type) {
            this._addThread(message.type)
        }

        // Log the message and set the thread date
        let conversationMessage = new ConversationMessage(message);
        this._thread.messages.add(conversationMessage);
        this._thread.date = message.date;
    }

    /**
     * Set the conversation recipient
     *
     * @param {Object} contact - A contact object for the message
     * @param {String} phoneNumber - The phone number (provided by Android)
     */
    setRecipient(contact, phoneNumber) {
        this._number = phoneNumber;
        this._displayNumber = phoneNumber;
        this._recipient = contact;

        // See if we have a nicer display number
        let strippedNumber = phoneNumber.replace(/\D/g, '');

        for (let contactNumber of contact.numbers) {
            if (strippedNumber === contactNumber.number.replace(/\D/g, '')) {
                this._displayNumber = contactNumber.number;
                break;
            }
        }

        // Populate the conversation
        this._populateMessages(strippedNumber);
        this._showMessages();
    }

    /**
     * Log an incoming message in the MessageList
     * TODO: this is being deprecated by 'kdeconnect.telephony.message', but we
     *       keep it for now so the telephony plugin can use it to fake support.
     *
     * @param {Object} contact - A contact object for this message
     * @param {Object} message - A telephony message object
     */
    receiveMessage(contact, message) {
        this._number = message.address;

        if (!this.recipient) {
            this.setRecipient(contact, message.address);
        }

        // Log an incoming telepony message (fabricated by the telephony plugin)
        this._addMessage({
            _id: ++this.message_id,     // message id (increment as we fetch)
            thread_id: this.thread_id,  // conversation id
            address: message.address,   // always the outgoing number
            body: message.body,
            date: message.date,
            event: 'sms',
            read: MessageStatus.UNREAD,
            type: MessageType.IN,
        });
    }

    /**
     * Send the contents of the message entry to the recipient
     */
    sendMessage(entry, signal_id, event) {
        // Ensure the action is enabled so we don't log messages without sending
        if (this.device.get_action_enabled('sendSms')) {
            this.device.activate_action(
                'sendSms',
                new GLib.Variant('(ss)', [this.number, entry.text])
            );

            // Log the outgoing message as a fabricated message packet
            this._addMessage({
                _id: ++this.message_id,    // message id (increment as we fetch)
                thread_id: this.thread_id,  // conversation id
                address: this.number,       // always the outgoing number?
                body: entry.text,
                date: Date.now(),
                event: 'sms',
                read: MessageStatus.READ,
                type: MessageType.OUT,
            });

            // Clear the entry
            this.message_entry.text = '';
        }
    }

    /**
     * Set the contents of the message entry and place the cursor at the end
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
    GTypeName: 'GSConnectConversationChooser'
}, class ConversationChooser extends Gtk.ApplicationWindow {

    _init(device, url) {
        super._init({
            application: Gio.Application.get_default(),
            title: _('Share Link'),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        this.device = device;
        this.url = url;

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
        window.setMessage(this.url);
        this.destroy();
        window.present();
    }

    _addWindows() {
        let windows = Gio.Application.get_default().get_windows();

        for (let index_ in windows) {
            let window = windows[index_];

            if (!window.device || window.device.id !== this.device.id) {
                continue;
            }

            if (window.number) {
                let recipient = window.recipient;

                let row = new Gtk.ListBoxRow();
                row.window_ = window;
                this.list.add(row);

                let grid = new Gtk.Grid({
                    margin: 6,
                    column_spacing: 6
                });
                row.add(grid);

                grid.attach(new Contacts.Avatar(recipient), 0, 0, 1, 2);

                let name = new Gtk.Label({
                    label: recipient.name,
                    halign: Gtk.Align.START
                });
                grid.attach(name, 1, 0, 1, 1);

                let number = new Gtk.Label({
                    label: window.number,
                    halign: Gtk.Align.START
                });
                number.get_style_context().add_class('dim-label');
                grid.attach(number, 1, 1, 1, 1);

                row.show_all();
            }
        }
    }
});

