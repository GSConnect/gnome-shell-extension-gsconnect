'use strict';

const Tweener = imports.tweener.tweener;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Color = imports.modules.color;
const Contacts = imports.modules.contacts;


/**
 * SMS Message direction
 */
var MessageDirection = {
    OUT: 0,
    IN: 1
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

        this.recipients = recipients.split(',').map((recipient) => {
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
 *
 */
var ConversationMessage = GObject.registerClass({
    GTypeName: 'GSConnectConversationMessage'
}, class ConversationMessage extends Gtk.Grid {

    _init(params) {
        Object.assign(this, {
            contact: null,
            direction: MessageDirection.OUT,
            message: null
        }, params);

        super._init({
            visible: true,
            halign: (this.direction) ? Gtk.Align.START : Gtk.Align.END
        });

        let messageContent = new Gtk.Label({
            label: this._linkify(this.message),
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12,
            margin_left: 12,
            selectable: true,
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: (params.direction) ? 0 : 1
        });
        messageContent.connect('activate-link', (label, uri) => {
            Gtk.show_uri_on_window(
                this.get_toplevel(),
                (uri.indexOf('://') < 0) ? 'http://' + uri : uri,
                Gdk.get_current_event_time()
            );
            return true;
        });
        this.connect('draw', this._onDraw.bind(this));
        this.add(messageContent);
    }

    _onDraw(widget, cr) {
        let [size, baseline] = widget.get_allocated_size();

        let color = (this.direction) ? this.contact.rgb : [ 0.83, 0.84, 0.81 ];

        cr.setSourceRGB(...color);
        cr.moveTo(12, 0);
        // Top right
        cr.lineTo(size.width - 12, 0);
        cr.arc(size.width - 12, 12, 12, 1.5 * Math.PI, 0);
        // Bottom right
        cr.lineTo(size.width, size.height - 12);
        cr.arc(size.width - 12, size.height - 12, 12, 0, 0.5 * Math.PI);
        // Bottom left
        cr.lineTo(12, size.height);
        cr.arc(12, size.height - 12, 12, 0.5 * Math.PI, 1.0 * Math.PI);
        // Top left
        cr.lineTo(0, 12);
        cr.arc(12, 12, 12, 1.0 * Math.PI, 1.5 * Math.PI);
        cr.fill();

        // Foreground
        Color.setFgClass(this, color);

        cr.$dispose();
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
        )
    }
}, class ConversationWindow extends Gtk.ApplicationWindow {

    _init(device) {
        super._init({
            application: Gio.Application.get_default(),
            title: _('SMS Conversation'),
            default_width: 300,
            default_height: 300,
            urgency_hint: true
        });

        this._device = device;
        this._notifications = [];
        this._thread = null;

        // Device Status
        this.connect('notify::connected', this._onConnected.bind(this));
        this.device.bind_property('connected', this, 'connected', GObject.BindingFlags.DEFAULT);

        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect('notify::number', this._setHeaderBar.bind(this));
        this.set_titlebar(this.headerBar);

        // Content Layout
        this.layout = new Gtk.Grid();
        this.add(this.layout);

        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING,
            revealed: false,
            visible: false
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: 'dialog-warning-symbolic' })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({
                // TRANSLATORS: eg. <b>Google Pixel</b> is disconnected
                label: _('<b>%s</b> is disconnected').format(this.device.name),
                use_markup: true
            })
        );
        this.layout.attach(this.infoBar, 0, 0, 1, 1);

        // Conversation Stack (Recipients/Threads)
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        this.layout.attach(this.stack, 0, 1, 1, 1);

        // Contacts
        this.contactList = new Contacts.ContactChooser();
        this.contactList.connect('number-selected', (widget, number) => {
            // FIXME FIXME
            this._setRecipient(
                widget.selected.get(number),
                number
            );
        });
        this.stack.add_named(this.contactList, 'contacts');

        // Messages
        let messageView = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        this.stack.add_named(messageView, 'messages');

        // Messages List
        let messageWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        messageView.add(messageWindow);

        this.messageList = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        this.messageList.connect('size-allocate', (widget) => {
            let vadj = messageWindow.get_vadjustment();
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        });
        messageWindow.add(this.messageList);

        // Message Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('Type an SMS message'),
            secondary_icon_name: 'sms-send',
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        this.entry.connect('changed', (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length);
        });
        this.entry.connect('activate', this.sendMessage.bind(this));
        this.entry.connect('icon-release', this.sendMessage.bind(this));
        messageView.add(this.entry);

        // Clear pending notifications on focus
        this.entry.connect('notify::has-focus', () => {
            while (this._notifications.length) {
                this.device.withdraw_notification(
                    this._notifications.pop()
                );
            }
        });

        // Finish initing
        this.show_all();
        this._setHeaderBar();
    }

    get device () {
        return this._device;
    }

    get number () {
        return this._number || null;
    }

    get recipient () {
        return this._recipient || null;
    }

    _onConnected() {
        this.contactList.entry.sensitive = this.connected;
        this.stack.sensitive = this.connected;
        this.infoBar.revealed = !this.connected;
        this.infoBar.visible = !this.connected;
    }

    /**
     * Set the Header Bar and stack child
     */
    _setHeaderBar() {
        if (this.recipient) {
            this.headerBar.custom_title = null;
            this.contactList.entry.text = '';

            if (this.recipient.name) {
                this.headerBar.set_title(this.recipient.name);
                this.headerBar.set_subtitle(this._displayNumber);
            } else {
                this.headerBar.set_title(this._displayNumber);
                this.headerBar.set_subtitle(null);
            }

            let avatar = new Contacts.Avatar(this.recipient);
            avatar.opacity = 0;
            avatar.halign = Gtk.Align.CENTER;
            avatar.valign = Gtk.Align.CENTER;
            this.headerBar.pack_start(avatar);

            this.entry.has_focus = true;

            // Totally unnecessary animation
            Tweener.addTween(avatar, {
                opacity: 1,
                time: 0.4,
                transition: 'easeOutCubic'
            });
            this.stack.set_visible_child_name('messages');
        } else {
            this.headerBar.custom_title = this.contactList.entry;
            this.contactList.entry.has_focus = true;
            this.stack.set_visible_child_name('contacts');
        }
    }

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {object} contact - The contact object
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    _addThread(direction) {
        let sender;

        if (direction === MessageDirection.IN) {
            sender = this.recipient.name || this.number;
        } else {
            sender = null;
        }

        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        row.direction = direction;
        this.messageList.add(row);

        let layout = new Gtk.Box({
            visible: true,
            can_focus: false,
            hexpand: true,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(layout);

        // Contact Avatar
        row.avatar = new Contacts.Avatar(this.recipient);
        row.avatar.tooltip_text = sender;
        row.avatar.valign = Gtk.Align.END;
        row.avatar.visible = direction;
        layout.add(row.avatar);

        // Messages
        row.messages = new Gtk.Box({
            visible: true,
            can_focus: false,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END,
            margin_right: (direction) ? 38 : 0,
            margin_left: (direction) ? 0: 38
        });
        layout.add(row.messages);

        this._thread = row;
        return row;
    }

    /**
     * Log a new message in the conversation
     *
     * @param {string} message - The message content
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     */
    _logMessage(message, direction=MessageDirection.OUT) {
        // Check if we need a new thread
        let thread;

        if (this._thread && this._thread.direction === direction) {
            thread = this._thread;
        } else {
            thread = this._addThread(direction)
        }

        let conversationMessage = new ConversationMessage({
            contact: this.recipient,
            direction: direction,
            message: message
        });
        thread.messages.add(conversationMessage);
    }

    /**
     * Set the conversation recipient
     */
    _setRecipient(contact, phoneNumber) {
        // We use the number from kdeconnect for transmission and comparisons
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

        this.notify('number');
    }

    /**
     * Log an incoming message in the MessageList
     * @param {Object} contact - A contact object for this message
     * @param {String} phoneNumber - The original phone number for this event
     * @param {String|Pango markup} messageBody - The message to be logged
     */
    receiveMessage(contact, phoneNumber, message) {
        this._number = phoneNumber;

        if (!this.recipient) {
            this._setRecipient(contact, phoneNumber);
        }

        this._logMessage(message, MessageDirection.IN);
    }

    /**
     * Send the contents of the message entry to the recipient
     */
    sendMessage(entry, signal_id, event) {
        if (!entry.text.length) {
            return;
        }

        // Send messages
        let action = this.device.lookup_action('sendSms');

        if (action && action.enabled) {
            let parameter = new GLib.Variant('(ss)', [this.number, entry.text]);
            action.activate(parameter);

            // Log the outgoing message
            this._logMessage(entry.text, MessageDirection.OUT);
            this.entry.text = '';
        }
    }

    /**
     * Send the contents of the message entry and place the cursor at the end
     * @param {String} text - The text to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.emit('move-cursor', 0, text.length, false);
    }
});


/**
 * A Gtk.ApplicationWindow for sharing links via SMS
 */
var ShareWindow = GObject.registerClass({
    GTypeName: 'GSConnectContactShareWindow'
}, class ShareWindow extends Gtk.ApplicationWindow {

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

