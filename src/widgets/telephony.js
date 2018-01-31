"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

// Local Imports
imports.searchPath.push(gsconnect.datadir);


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
 * Color functions
 */
var Color = {
    randomRGB: function () {
        return [Math.random(), Math.random(), Math.random()];
    },

    // See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
    relativeLuminance: function (r, g, b) {
        if (r instanceof Array) {
            [r, g, b] = r;
        }

        let R = (r > 0.03928) ? r / 12.92 : Math.pow(((r + 0.055)/1.055), 2.4);
        let G = (g > 0.03928) ? g / 12.92 : Math.pow(((g + 0.055)/1.055), 2.4);
        let B = (b > 0.03928) ? b / 12.92 : Math.pow(((b + 0.055)/1.055), 2.4);

        return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    },

    relativeFgClass: function (r, g, b) {
        if (r instanceof Array) {
            [r, g, b] = r;
        }

        let bg = this.relativeLuminance(r, g, b);
        let lfg = this.relativeLuminance(0.94, 0.94, 0.94);
        let dfg = this.relativeLuminance(0.06, 0.06, 0.06);

        let lcon = (lfg + 0.05) / (bg + 0.05);
        let dcon = (bg + 0.05) / (dfg + 0.05);

        return (lcon > dcon) ? "light-text" : "dark-text";
    }
};


/**
 * Contact Avatar
 */
var ContactAvatar = new Lang.Class({
    Name: "GSConnectContactAvatar",
    Extends: Gtk.DrawingArea,

    _init: function (contact, size=32) {
        this.parent({
            height_request: size,
            width_request: size,
            vexpand: false,
            hexpand: false
        });

        this.contact = contact;
        this.size = size;
        this.center = size/2;

        if (this.contact.avatar) {
            log("AVATAR: " + contact.avatar); // FIXME
            let loader = new GdkPixbuf.PixbufLoader();
            loader.write(GLib.file_get_contents(this.contact.avatar)[1]);

            // Consider errors at this point to be warnings
            try {
                loader.close();
            } catch (e) {
                debug("Warning: " + e.message);
            }

            let pixbuf = loader.get_pixbuf().scale_simple(
                this.size,
                this.size,
                GdkPixbuf.InterpType.HYPER
            );

            this.surface = Gdk.cairo_surface_create_from_pixbuf(
                pixbuf,
                0,
                this.get_window()
            );
        } else {
            let theme = Gtk.IconTheme.get_default();
            this.surface = theme.load_surface(
                "avatar-default-symbolic",
                this.size/1.5,
                1,
                null,
                0
            );
        }

        this.connect("draw", (widget, cr) => this._onDraw(widget, cr));
    },

    _onDraw: function (widget, cr) {
        let offset = 0;

        if (!this.contact.avatar) {
            offset = (this.size - this.size/1.5) / 2;

            cr.setSourceRGB(...this.contact.rgb);
            cr.arc(this.size/2, this.size/2, this.size/2, 0, 2*Math.PI);
            cr.fill();

            //cr.setOperator(Cairo.Operator.HSL_SATURATION);
            let fgClass = Color.relativeFgClass(this.contact.rgb);
            let fgColor = (fgClass === "dark-text") ? 0.06 : 0.94;
            cr.setSourceRGB(fgColor, fgColor, fgColor);
            cr.maskSurface(this.surface, offset, offset);
            cr.fill();
        } else {
            cr.setSourceSurface(this.surface, offset, offset);
            cr.arc(this.size/2, this.size/2, this.size/2, 0, 2*Math.PI);
            cr.clip();
            cr.paint();
        }

        cr.$dispose();
        return false;
    }
});


var ContactList = new Lang.Class({
    Name: "GSConnectContactList",
    Extends: Gtk.ScrolledWindow,
    Properties: {
        "selected": GObject.param_spec_variant(
            "selected",
            "selectedContacts",
            "A list of selected contacts",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        "number-selected": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    },

    _init: function (params) {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });

        this.contacts = params.contacts;

        if (params.entry) {
            this.entry = params.entry;
            this.entry.connect("changed", (entry) => this._onEntryChanged());
        }

        // ListBox
        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this.list.set_filter_func(Lang.bind(this, this._filter));
        this.list.set_sort_func(Lang.bind(this, this._sort));
        this.add(this.list);

        // Placeholder
        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            visible: true,
            hexpand: true,
            halign: Gtk.Align.CENTER,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            margin: 12,
            spacing: 12
        });

        let placeholderImage = new Gtk.Image({
            icon_name: "avatar-default-symbolic",
            pixel_size: 48,
            visible: true
        });
        placeholderImage.get_style_context().add_class("dim-label");
        box.add(placeholderImage);

        let placeholderLabel = new Gtk.Label({
            label: "<b>" + _("Add people to start a conversation") + "</b>",
            visible: true,
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER
        });
        placeholderLabel.get_style_context().add_class("dim-label");

        box.add(placeholderLabel);
        this.list.set_placeholder(box);

        // Populate and setup
        this._selected = new Map();
        this._populate();
        this.show_all();
        this.entry.has_focus = true;
        this.list.unselect_all();
    },

    get selected () {
        return this._selected;
    },

    /**
     * Add a new contact row to the list
     */
    _addContact: function (contact) {
        contact.rgb = Color.randomRGB();

        let row = new Gtk.ListBoxRow({
            activatable: false
        });
        row.contact = contact;

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6
        });
        row.add(grid);

        grid.attach(new ContactAvatar(contact), 0, 0, 1, 2);

        row._name = new Gtk.Label({
            label: contact.name || _("Unknown Contact"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        grid.attach(row._name, 1, 0, 1, 1);

        row.numbers = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3
        });
        grid.attach(row.numbers, 1, 1, 1, 1);

        this.list.add(row);

        for (let number of contact.numbers) {
            this._addContactNumber(row, number);
        }

        return row;
    },

    /**
     * Add a contact number to a row
     */
    _addContactNumber: function (row, number) {
        let box = new Gtk.Box();
        box.number = number;
        row.numbers.add(box);

        box._number = new Gtk.Label({
            label: number.number || _("Unknown Number"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        box._number.get_style_context().add_class("dim-label");
        box.add(box._number);

        box._type = new Gtk.Label({
            label: this._localizeType(number.type),
            margin_right: 12,
            use_markup: true
        });
        box._type.get_style_context().add_class("dim-label");
        box.add(box._type);

        box.recipient = new Gtk.CheckButton({
            active: false,
            margin_right: 12
        });
        box.recipient.connect("toggled", () => {
            this._toggle(row, box);
        });
        box.add(box.recipient);

        row.show_all();
    },

    _onEntryChanged: function (entry) {
        if (this.entry.text.replace(/\D/g, "").length > 2) {
            if (this._dynamic) {
                this._dynamic._name.label = _("Send to %s").format(this.entry.text);
                let num = this._dynamic.numbers.get_children()[0];
                num._number.label = this.entry.text;
                num.contact.number = this.entry.text;
            } else {
                this._dynamic = this._addContact({
                    name: _("Unknown Contact"),
                    numbers: [{ type: "unknown", number: this.entry.text }]
                });
                this._dynamic._name.label = _("Send to %s").format(this.entry.text);
                this._dynamic.dynamic = true;
            }
        } else if (this._dynamic) {
            this._dynamic.destroy();
            delete this._dynamic;
        }

        this.list.invalidate_sort();
        this.list.invalidate_filter();
    },

    _filter: function (row) {
        let queryName = this.entry.text.toLowerCase();
        let queryNumber = this.entry.text.replace(/\D/g, "");

        // Dynamic contact always shown
        if (row.dynamic) {
            return true;
        // Show if text is substring of name
        } else if (row._name.label.toLowerCase().indexOf(queryName) > -1) {
            row.show_all();
            return true;
        // Show or hide numbers based on substring
        } else if (filterNumber.length) {
            let matched = false

            for (let num of row.numbers.get_children()) {
                let number = num._number.label.replace(/\D/g, "");
                if (number.indexOf(queryNumber) > -1) {
                    num.visible = true;
                    matched = true;
                } else {
                    num.visible = false;
                }
            }

            return matched;
        }

        return false;
    },

    /**
     * Return a localized string for a phone number type
     *
     * See: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
     *      http://www.ietf.org/rfc/rfc2426.txt
     */
    _localizeType: function (type) {
        if (!type) { return _("Other"); }

        if (type.indexOf("fax") > -1) {
            // TRANSLATORS: A phone number type
            return _("Fax");
        // Sometimes libfolks->voice === GData->work
        } else if (type.indexOf("work") > -1 || type.indexOf("voice") > -1) {
            // TRANSLATORS: A phone number type
            return _("Work");
        } else if (type.indexOf("cell") > -1 || type.indexOf("mobile") > -1) {
            // TRANSLATORS: A phone number type
            return _("Mobile");
        } else if (type.indexOf("home") > -1 ) {
            // TRANSLATORS: A phone number type
            return _("Home");
        } else {
            // TRANSLATORS: A phone number type
            return _("Other");
        }
    },

    _populate: function () {
        this.list.foreach(child => child.destroy());

        for (let id in this.contacts) {
            this._addContact(this.contacts[id]);
        }
    },

    _sort: function (row1, row2) {
        if (row1.dynamic) {
            return -1;
        } else if (row2.dynamic) {
            return 1;
        } else {
            let row1active, row2active;

            for (let num of row1.numbers.get_children()) {
                if (num.recipient.active) {
                    row1active = true;
                    break;
                }
            }

            for (let num of row2.numbers.get_children()) {
                if (num.recipient.active) {
                    row2active = true;
                    break;
                }
            }

            if (row1active && !row2active) {
                return -1;
            } else if (!row1active && row2active) {
                return 1;
            }
        }

        return row1._name.label.localeCompare(row2._name.label);
    },

    _toggle: function (row, box) {
        if (box.recipient.active) {
            if (row.dynamic) {
                row._name.label = box.contact.name;
                delete this._dynamic;
            }

            this._selected.set(box.number.number, row.contact);
            this.notify("selected");
            this.emit("number-selected", box.number.number);
        } else {
            this._selected.delete(box.number.number);
            this.notify("selected");
        }

        this.entry.text = "";
        this.list.invalidate_sort();
    }
});


var ConversationMessage = new Lang.Class({
    Name: "GSConnectConversationMessage",
    Extends: Gtk.Grid,

    _init: function (params) {
        Object.assign(this,
            Object.assign({
                contact: null,
                direction: MessageDirection.OUT,
                message: null
            }, params)
        );

        this.parent({
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
        messageContent.connect("activate-link", (label, uri) => {
            Gtk.show_uri_on_window(
                this.get_toplevel(),
                (uri.indexOf("://") < 0) ? "http://" + uri : uri,
                Gdk.get_current_event_time()
            );
            return true;
        });
        this.connect("draw", (widget, cr) => this._draw(widget, cr));
        this.add(messageContent);
    },

    _draw: function (widget, cr) {
        let [size, baseline] = widget.get_allocated_size();
        //let size = this.get_allocation();

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
        let fgClass = Color.relativeFgClass(color);
        let css = widget.get_style_context();

        if (fgClass === "dark-text") {
            css.remove_class("light-text");
        } else if (fgClass === "light-text") {
            css.remove_class("dark-text");
        }

        widget.get_style_context().add_class(fgClass);

        return false;
    },

    /**
     * Return a string with URLs couched in <a> tags, parseable by Pango and
     * using the same RegExp as Gnome Shell.
     *
     * @param {string} text - The string to be modified
     * @return {string} - the modified text
     */
    _linkify: function (text) {
        _urlRegexp.lastIndex = 0;
        return text.replace(
            _urlRegexp,
            '$1<a href="$2">$2</a>'
        ).replace(
            /&(?!amp;)/g,
            "&amp;"
        );
    },
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = new Lang.Class({
    Name: "GSConnectConversationWindow",
    Extends: Gtk.ApplicationWindow,
    Properties: {
        "device": GObject.ParamSpec.object(
            "device",
            "WindowDevice",
            "The device associated with this window",
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        "number": GObject.ParamSpec.string(
            "number",
            "RecipientPhoneNumber",
            "The conversation recipient's phone number",
            GObject.ParamFlags.READABLE,
            ""
        )
    },

    _init: function (device) {
        this.parent({
            application: device.daemon,
            title: _("SMS Conversation"),
            default_width: 300,
            default_height: 300
        });

        this._device = device;
        this._notifications = [];

        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect("notify::number", () => this._setHeaderBar());
        this.set_titlebar(this.headerBar);

        // Contact Entry
        let plugin = this.device._plugins.get("telephony");
        this.contactEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: plugin.contacts_provider,
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE
        });
        plugin.bind_property(
            "contacts-provider",
            this.contactEntry,
            "primary-icon-name",
            GObject.BindingFlags.SYNC_CREATE
        );
        this.headerBar.custom_title = this.contactEntry;

        // Content Layout
        this.layout = new Gtk.Grid();
        this.add(this.layout);

        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({
                // TRANSLATORS: eg. <b>Google Pixel</b> is disconnected
                label: _("<b>%s</b> is disconnected").format(this.device.name),
                use_markup: true
            })
        );
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        this.device.connect("notify::connected", () => {
            let connected = this.device.connected;

            this.contactEntry.sensitive = connected;
            this.stack.sensitive = connected;

            if (!connected) {
                this.layout.attach(this.infoBar, 0, 0, 1, 1);
                this.infoBar.show_all();
            } else if (connected) {
                this.infoBar.hide();
                this.layout.remove(this.infoBar);
            }
        });

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
        this.contactList = new ContactList({
            contacts: this.device._plugins.get("telephony")._contacts,
            entry: this.contactEntry
        });
        this.contactList.connect("number-selected", (widget, number) => {
            this._setRecipient(
                number,
                widget.selected.get(number)
            );
        });
        this.stack.add_named(this.contactList, "contacts");

        // Messages
        let messageView = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        this.stack.add_named(messageView, "messages");

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
        this.messageList.connect("size-allocate", (widget) => {
            let vadj = messageWindow.get_vadjustment();
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        });
        messageWindow.add(this.messageList);

        // Message Entry
        this.messageEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            secondary_icon_name: "sms-send",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        this.messageEntry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length);
        });
        this.messageEntry.connect("activate", entry => this.send(entry));
        this.messageEntry.connect("icon-release", entry => this.send(entry));
        messageView.add(this.messageEntry);

        // Clear pending notifications on focus
        this.messageEntry.connect("notify::has-focus", () => {
            while (this._notifications.length) {
                this.device.withdraw_notification(
                    this._notifications.pop()
                );
            }
        });

        // Finish initing
        this.show_all();
        this.notify("number");
    },

    get device () {
        return this._device;
    },

    get number () {
        return this._number.number;
    },

    get recipient () {
        return this._recipient || null;
    },

    getRecipient: function () {
        return this.recipient;
    },

    /**
     * Set the Header Bar and stack child
     */
    _setHeaderBar: function () {
        if (this.recipient) {
            if (this.recipient.name) {
                this.headerBar.set_title(this.recipient.name);
                this.headerBar.set_subtitle(this.number);
            } else {
                this.headerBar.set_title(this.number);
                this.headerBar.set_subtitle(null);
            }

            this.headerBar.set_tooltip_text(
                // TRANSLATORS: eg. SMS Conversation with John, Paul, George, Ringo
                _("SMS Conversation with %s").format(this.recipient.name || this.number)
            );

            this._showMessages();
        } else {
            this.headerBar.set_title(_("New SMS Conversation"));
            this.headerBar.set_subtitle(null);
            this.headerBar.set_tooltip_text("");
            this._showContacts();
        }
    },

    _showContacts: function () {
        this.headerBar.custom_title = this.contactEntry;
        this.contactEntry.has_focus = true;
        this.stack.set_visible_child_name("contacts");
    },

    _showMessages: function () {
        this.headerBar.custom_title = null;
        this.contactEntry.text = "";
        this.messageEntry.has_focus = true;
        this.stack.set_visible_child_name("messages");
    },

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {object} contact - The contact object
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    _addThread: function (direction) {
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
        this.messageList.add(row);

        row.layout = new Gtk.Box({
            visible: true,
            can_focus: false,
            hexpand: true,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(row.layout);

        // Contact Avatar
        row.avatar = new ContactAvatar(this.recipient);
        row.avatar.tooltip_text = sender;
        row.avatar.valign = Gtk.Align.END;
        row.avatar.visible = direction;
        row.layout.add(row.avatar);

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
        row.layout.add(row.messages);

        return row;
    },

    /**
     * Add a new message, calling addThread() if necessary to create a new
     * thread.
     *
     * @param {string} messageBody - The message content
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     */
    _addThreadMessage: function (messageBody, direction=MessageDirection.OUT) {
        let sender;

        if (direction === MessageDirection.IN) {
            sender = this.recipient.name || this.number;
        } else {
            sender = null;
        }

        let nrows = this.messageList.get_children().length;
        let row, currentThread;

        if (nrows) {
            let currentThread = this.messageList.get_row_at_index(nrows - 1);

            if (currentThread.avatar.tooltip_text === sender) {
                row = currentThread;
            }
        }

        if (!row) {
            row = this._addThread(direction);
        }

        let messageBubble = new ConversationMessage({
            contact: this.recipient,
            direction: direction,
            message: messageBody
        });
        row.messages.add(messageBubble);
    },

    _setRecipient: function (number, contact) {
        this._number = { number: number.replace(/\D/g, "") };

        for (let num of contact.numbers) {
            if (number.replace(/\D/g, "") === num.number.replace(/\D/g, "")) {
                this._number = num;
            }
        }

        this._recipient = contact;
        this.notify("number");
    },

    /** Log an incoming message in the MessageList */
    receive: function (contact, phoneNumber, messageBody) {
        if (!this.recipient) {
            this._setRecipient(phoneNumber, contact);
        }

        this._addThreadMessage(messageBody, MessageDirection.IN);
    },

    /** Send the contents of MessageView.entry to each recipient */
    send: function (entry, signal_id, event) {
        if (!entry.text.length) {
            return;
        }

        let plugin = this.device._plugins.get("telephony");
        plugin.sendSms(this.number, entry.text);

        // Log the outgoing message
        this._addThreadMessage(entry.text, MessageDirection.OUT);
        entry.text = "";
    },

    setEntry: function (text) {
        this.messageEntry.text = text;
        this.messageEntry.emit("move-cursor", 0, text.length, false);
    }
});


/**
 * A Gtk.ApplicationWindow for sharing links via SMS
 */
var ShareWindow = new Lang.Class({
    Name: "GSConnectContactShareWindow",
    Extends: Gtk.ApplicationWindow,

    _init: function (device, url) {
        this.parent({
            application: device.daemon,
            title: _("Share Link"),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        this.device = device;
        this.url = url;

        // HeaderBar
        let headerbar = new Gtk.HeaderBar({
            title: _("Share Link"),
            subtitle: url,
            show_close_button: true,
            tooltip_text: url
        });
        this.set_titlebar(headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({ icon_name: "list-add-symbolic" }),
            tooltip_text: _("New Conversation"),
            always_show_image: true
        });
        newButton.connect("clicked", () => {
            let window = new ConversationWindow(this.device);
            window.setEntry(url);
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
        this.list.connect("row-activated", (list, row) => this._select(row.window_));
        this.list.connect("selected-rows-changed", () => {
            // TODO: not a button anymore
            sendButton.sensitive = (this.list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        // Filter Setup
        this.show_all();
        this._addWindows();
    },

    _select: function (window) {
        window.setEntry(this.url);
        this.destroy();
        window.present();
    },

    _addWindows: function () {
        let windows = this.device.daemon.get_windows();

        for (let index_ in windows) {
            let window = windows[index_];

            if (!window.device || window.device.id !== this.device.id) {
                continue;
            }

            if (window.number) {
                let recipient = window.getRecipient();

                let row = new Gtk.ListBoxRow();
                row.window_ = window;
                this.list.add(row);

                let grid = new Gtk.Grid({
                    margin: 6,
                    column_spacing: 6
                });
                row.add(grid);

                grid.attach(new ContactAvatar(recipient), 0, 0, 1, 2);

                let name = new Gtk.Label({
                    label: recipient.name,
                    halign: Gtk.Align.START
                });
                grid.attach(name, 1, 0, 1, 1);

                let number = new Gtk.Label({
                    label: window.number,
                    halign: Gtk.Align.START
                });
                number.get_style_context().add_class("dim-label");
                grid.attach(number, 1, 1, 1, 1);

                row.show_all();
            }
        }
    }
});

