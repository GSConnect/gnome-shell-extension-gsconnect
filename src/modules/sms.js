'use strict';

const Tweener = imports.tweener.tweener;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

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
        messageContent.connect('activate-link', this._onActivateLink.bind(this));
        this.connect('draw', this._onDraw.bind(this));
        this.add(messageContent);
    }

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            (uri.indexOf('://') < 0) ? 'http://' + uri : uri,
            Gdk.get_current_event_time()
        );
        return true;
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
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/conversation-window.ui',
    Children: [
        'headerbar',
        'overlay', 'info-box', 'info-box', 'info-button', 'info-label', 'stack',
        'message-window', 'message-list', 'message-entry'
    ]
}, class ConversationWindow extends Gtk.ApplicationWindow {

    _init(device) {
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(this));
        });

        super._init({
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 300,
            urgency_hint: true
        });

        this._device = device;
        this._notifications = [];
        this._thread = null;

        // TRANSLATORS: eg. <b>Google Pixel</b> is disconnected
        this.info_label.label = _('%s is disconnected').format(this.device.name);

        // Contacts
        this.contact_list = new Contacts.ContactChooser();
        this._numberSelectedId = this.contact_list.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );
        this.stack.add_named(this.contact_list, 'contacts');
        this.stack.child_set_property(this.contact_list, 'position', 0);
        this.stack.set_visible_child_name('contacts');

        // Device Status
        this._deviceBinding = this.device.bind_property(
            'connected', this, 'connected', GObject.BindingFlags.SYNC_CREATE
        );
        this.overlay.remove(this.info_box);

        // Finish initing
        this.show_all();
        this._onNumberChanged();
    }

    get device() {
        return this._device;
    }

    get number() {
        return this._number || null;
    }

    get recipient() {
        return this._recipient || null;
    }

    _onConnected(window) {
        let children = this.overlay.get_children();

        // If disconnected, add the info box before revealing
        if (!window.connected && !children.includes(this.info_box)) {
            window.overlay.add_overlay(window.info_box);
        }

        window.contact_list.entry.sensitive = window.connected;
        window.stack.opacity = (window.connected) ? 1 : 0.3;
        window.info_box.reveal_child = !window.connected;
    }

    /**
     * Add/Remove the infobox after the reveal completes
     */
    _onRevealed(revealer) {
        let children = this.overlay.get_children();

        // If connected, remove the info box after revealing
        if (this.connected && children.includes(this.info_box)) {
            this.overlay.remove(this.info_box);
        }
    }

    _onDestroy(window) {
        window.get_titlebar().remove(window.contact_list.entry);
        window.contact_list.disconnect(window._numberSelectedId);
        window.contact_list.destroy();
        delete window.contact_list;

        window._deviceBinding.unbind();
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onEntryHasFocus(entry) {
        while (this._notifications.length) {
            this.device.withdraw_notification(this._notifications.pop());
        }
    }

    _onInfoButtonClicked(button) {
        this.device.activate();
    }

    _onMessageLogged(listbox) {
        let vadj = this.message_window.get_vadjustment();
        vadj.set_value(vadj.get_upper() - vadj.get_page_size());
    }

    _onNumberSelected(contact_list, number) {
        this._setRecipient(contact_list.selected.get(number), number);
    }

    /**
     * Set the Header Bar and stack child
     */
    _onNumberChanged(window) {
        if (this.recipient) {
            this.headerbar.custom_title = null;
            this.contact_list.entry.text = '';

            if (this.recipient.name) {
                this.headerbar.set_title(this.recipient.name);
                this.headerbar.set_subtitle(this._displayNumber);
            } else {
                this.headerbar.set_title(this._displayNumber);
                this.headerbar.set_subtitle(null);
            }

            let avatar = new Contacts.Avatar(this.recipient);
            avatar.opacity = 0;
            avatar.halign = Gtk.Align.CENTER;
            avatar.valign = Gtk.Align.CENTER;
            this.headerbar.pack_start(avatar);

            this.message_entry.has_focus = true;

            // Totally unnecessary animation
            Tweener.addTween(avatar, {
                opacity: 1,
                time: 0.4,
                transition: 'easeOutCubic'
            });
            this.stack.set_visible_child_name('messages');
        } else {
            this.headerbar.custom_title = this.contact_list.entry;
            this.contact_list.entry.has_focus = true;
            this.stack.set_visible_child_name('contacts');
        }
    }

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
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
        this.message_list.add(row);

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
        if (!this._thread || this._thread.direction !== direction) {
            this._addThread(direction)
        }

        let conversationMessage = new ConversationMessage({
            contact: this.recipient,
            direction: direction,
            message: message
        });
        this._thread.messages.add(conversationMessage);
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

        if (this.device.get_action_enabled('sendSms')) {
            this.device.activate_action(
                'sendSms',
                new GLib.Variant('(ss)', [this.number, entry.text])
            );

            // Log the outgoing message
            this._logMessage(entry.text, MessageDirection.OUT);
            this.message_entry.text = '';
        }
    }

    /**
     * Send the contents of the message entry and place the cursor at the end
     *
     * @param {String} text - The text to place in the entry
     */
    setMessage(text) {
        this.message_entry.text = text;
        this.message_entry.emit('move-cursor', 0, text.length, false);
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

