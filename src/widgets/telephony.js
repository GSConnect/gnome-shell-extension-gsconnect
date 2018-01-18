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
imports.searchPath.push(ext.datadir);

const Common = imports.common;


/**
 * SMS Message direction
 */
var MessageDirection = {
    OUT: 0,
    IN: 1
};


/**
 * Message Bubble Colours
 * See: https://developer.gnome.org/hig/stable/icons-and-artwork.html
 *      http://tango.freedesktop.org/Tango_Icon_Theme_Guidelines#Color_Palette
 *      http://leaverou.github.io/contrast-ratio/
 */
var shuffleColor = Array.shuffler([
    "contact-color-butter1",
    "contact-color-butter2",
    "contact-color-butter3",
    "contact-color-orange1",
    "contact-color-orange2",
    "contact-color-orange3",
    "contact-color-chocolate1",
    "contact-color-chocolate2",
    "contact-color-chocolate3",
    "contact-color-chameleon1",
    "contact-color-chameleon2",
    "contact-color-chameleon3",
    "contact-color-skyblue1",
    "contact-color-skyblue2",
    "contact-color-skyblue3",
    "contact-color-plum1",
    "contact-color-plum2",
    "contact-color-plum3",
    "contact-color-scarletred1",
    "contact-color-scarletred2",
    "contact-color-scarletred3",
    "contact-color-aluminium1",
    "contact-color-aluminium2",
    "contact-color-aluminium3"
]);


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
 * Contact Avatar
 */
var ContactAvatar = new Lang.Class({
    Name: "GSConnectContactAvatar",
    Extends: Gtk.DrawingArea,

    _init: function (params) {
        params = Object.assign({
            path: null,
            size: 32
        }, params);

        this.parent({
            height_request: params.size,
            width_request: params.size
        });

        this.loader = new GdkPixbuf.PixbufLoader();

        if (params.path) {
            this.loader.write(GLib.file_get_contents(params.path)[1]);
        }

        // Consider errors at this point to be warnings
        try {
            this.loader.close();
        } catch (e) {
            debug("Warning: " + e.message);
        }

        let pixbuf = this.loader.get_pixbuf().scale_simple(
            params.size,
            params.size,
            GdkPixbuf.InterpType.HYPER
        );

        let surface = Gdk.cairo_surface_create_from_pixbuf(
            pixbuf,
            0,
            this.get_window()
        );

        this.connect("draw", (widget, cr) => {
            cr.setSourceSurface(surface, 0, 0);
            cr.arc(params.size/2, params.size/2, params.size/2, 0, 2*Math.PI);
            cr.clip();
            cr.paint();
            cr.$dispose();
            return false;
        });
    }
});


function getAvatar (contact) {
    let avatar;

    if (contact.avatar) {
        try {
            avatar = new ContactAvatar({ path: contact.avatar });
        } catch (e) {
            debug("Error creating avatar: " + e);
            avatar = getDefaultAvatar(contact);
        }
    } else {
        avatar = getDefaultAvatar(contact);
    }

    return avatar;
};


function getDefaultAvatar (contact) {
    let avatar = new Gtk.Box({
        width_request: 32,
        height_request: 32,
        valign: Gtk.Align.START
    });
    let avatarStyle = avatar.get_style_context();
    avatarStyle.add_class("contact-avatar");
    avatarStyle.add_class(contact.color || shuffleColor());

    let defaultAvatar = new Gtk.Image({
        icon_name: "avatar-default-symbolic",
        pixel_size: 24,
        margin: 4,
        visible: true
    });
    avatar.add(defaultAvatar);

    return avatar;
};


var ContactList = new Lang.Class({
    Name: "GSConnectContactList",
    Extends: Gtk.ScrolledWindow,

    _init: function (params) {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });

        this._parent = params.parent;
        this.contacts = params.contacts;
        this.entry = params.entry;
        this.entry.connect("changed", () => { this._changed(); });

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
        this._populate();
        this.show_all();
        this.entry.has_focus = true;
        this.list.unselect_all();
    },

    addContact: function (contact) {
        let row = new Gtk.ListBoxRow({
            activatable: false
        });
        row.color = shuffleColor();

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6
        });
        row.add(grid);

        grid.attach(getAvatar(contact), 0, 0, 1, 2);

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

        return row;
    },

    addNumber: function (contact) {
        let row = false;

        for (let child of this.list.get_children()) {
            if (contact.name !== _("Unknown Contact") && contact.name === child._name.label) {
                row = child;
                break;
            }
        }

        if (!row) {
            row = this.addContact(contact);
        }

        contact.color = row.color;

        let box = new Gtk.Box();
        box.contact = contact;
        row.numbers.add(box);

        box._number = new Gtk.Label({
            label: contact.number || _("Unknown Number"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        box._number.get_style_context().add_class("dim-label");
        box.add(box._number);

        box._type = new Gtk.Label({
            label: this._localizeType(contact.type),
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

        return row;
    },

    _changed: function (entry) {
        if (this.entry.text.replace(/\D/g, "").length > 2) {
            if (this._dynamic) {
                this._dynamic._name.label = _("Send to %s").format(this.entry.text);
                let num = this._dynamic.numbers.get_children()[0];
                num._number.label = this.entry.text;
                num.contact.number = this.entry.text;
            } else {
                this._dynamic = this.addNumber({
                    name: _("Unknown Contact"),
                    number: this.entry.text
                });
                this._dynamic._name.label = _("Send to %d").format(this.entry.text);
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
        let name = row._name.label.toLowerCase();
        let filterNumber = this.entry.text.replace(/\D/g, "");

        if (row.dynamic) {
            return true;
        } else if (name.indexOf(this.entry.text.toLowerCase()) > -1) {
            row.show_all();
            return true;
        } else if (filterNumber.length) {
            let matched = false

            for (let num of row.numbers.get_children()) {
                let number = num.contact.number.replace(/\D/g, "");
                if (number.indexOf(filterNumber) > -1) {
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
        this.list.foreach((child) => { child.destroy(); });

        for (let contact of this.contacts) {
            this.addNumber(contact);
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
            this._parent.addRecipient(box.contact);
        } else {
            this._parent.removeRecipient(box.contact);
            if (row.dynamic) {
                row.destroy();
            }
        }

        this.entry.text = "";
        this.list.invalidate_sort();
    }
});


var MessageView = new Lang.Class({
    Name: "GSConnectMessageView",
    Extends: Gtk.Box,

    _init: function (window) {
        this.parent({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });

        this._parent = window;

        // Messages List
        this.threadWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        this.add(this.threadWindow);

        this.list = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        this.list.connect("size-allocate", (widget) => {
            let vadj = this.threadWindow.get_vadjustment();
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        });
        this.threadWindow.add(this.list);

        // Message Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            secondary_icon_name: "sms-send",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });

        this.entry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length);
        });

        this.entry.connect("activate", (entry, signal_id, data) => {
            this._parent.send(entry, signal_id, data);
        });

        this.entry.connect("icon-release", (entry, signal_id, data) => {
            this._parent.send(entry, signal_id, data);
        });

        this.add(this.entry);
    },

    /**
     * Return a string with URLs couched in link tags, parseable by Pango and
     * using the same RegExp as Gnome Shell.
     *
     * @param {string} text - The string to be modified
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

    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {object} contact - The contact object
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addThread: function (contact, direction) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        this.list.add(row);

        row.layout = new Gtk.Box({
            visible: true,
            can_focus: false,
            hexpand: true,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(row.layout);

        // Contact Avatar
        row.avatar = getAvatar(contact);
        row.avatar.tooltip_text = contact.name || contact.number;
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
     * @param {string} contact - The contact object
     * @param {string} messageBody - The message content
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     */
    addMessage: function (contact, messageBody, direction) {
        let sender = contact.name || contact.number;
        let nrows = this.list.get_children().length;
        let row, currentThread;

        if (nrows) {
            let currentThread = this.list.get_row_at_index(nrows - 1);

            if (currentThread.avatar.tooltip_text === sender) {
                row = currentThread;
            }
        }

        if (!row) {
            row = this.addThread(contact, direction);
        }

        let messageBubble = new Gtk.Grid({
            visible: true,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        let messageBubbleStyle = messageBubble.get_style_context();
        messageBubbleStyle.add_class("message-bubble");
        messageBubbleStyle.add_class(contact.color);
        row.messages.add(messageBubble);

        let messageContent = new Gtk.Label({
            label: this._linkify(messageBody),
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12,
            margin_left: 12,
            selectable: true,
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: (direction) ? 0 : 1
        });
        messageContent.connect("activate-link", (label, uri) => {
            Gtk.show_uri_on_window(
                this.get_toplevel(),
                (uri.indexOf("://") < 0) ? "http://" + uri : uri,
                Gdk.get_current_event_time()
            );
            return true;
        });
        messageBubble.add(messageContent);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = new Lang.Class({
    Name: "GSConnectConversationWindow",
    Extends: Gtk.ApplicationWindow,
    Properties: {
        "deviceId": GObject.ParamSpec.string(
            "deviceId",
            "deviceId",
            "The device associated with this window",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "numbers": GObject.param_spec_variant(
            "numbers",
            "NumberList",
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },

    _init: function (device) {
        this.parent({
            application: device.daemon,
            title: _("SMS Conversation"),
            default_width: 300,
            default_height: 300
        });

        this.device = device;
        this.recipients = new Map();
        this._notifications = [];

        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect("notify::numbers", () => this._setHeaderBar());
        this.set_titlebar(this.headerBar);

        // Contact Button
        this.contactButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "contact-new-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            // TRANSLATORS: Tooltip for a button to add/remove people from a conversation
            tooltip_text: _("Add and remove people")
        });
        this.contactButton.connect("clicked", () => this._showContacts());
        this.headerBar.pack_start(this.contactButton);

        // Messages Button
        this.messagesButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "go-previous-symbolic",
                pixel_size: 16
            }),
            always_show_image: true
        });
        this.messagesButton.connect("clicked", () => this._showMessages());
        this.headerBar.pack_start(this.messagesButton);

        // Contact Entry
        let contactsCache = this.device._plugins.get("telephony")._cache;
        this.contactEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: contactsCache.provider,
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE
        });
        contactsCache.connect("notify::provider", () => {
            this.contactEntry.primary_icon_name = contactsCache.provider;
        });
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
            if (!this.device.connected) {
                this.contactButton.sensitive = false;
                this.messagesButton.sensitive = false;
                this.contactEntry.sensitive = false;
                this.stack.sensitive = false;

                this.layout.attach(this.infoBar, 0, 0, 1, 1);
                this.infoBar.show_all();
            } else if (this.device.connected) {
                this.contactButton.sensitive = true;
                this.messagesButton.sensitive = true;
                this.contactEntry.sensitive = true;
                this.stack.sensitive = true;

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

        // Contact List
        this.contactList = new ContactList({
            parent: this,
            contacts: this.device._plugins.get("telephony")._cache.contacts,
            entry: this.contactEntry
        });
        this.stack.add_named(this.contactList, "contacts");

        // MessageView
        this.messageView = new MessageView(this);
        this.stack.add_named(this.messageView, "messages");

        // Clear pending notifications on focus
        this.messageView.entry.connect("notify::has-focus", () => {
            while (this._notifications.length) {
                this.application.withdraw_notification(
                    this._notifications.pop()
                );
            }
        });

        // Finish initing
        this.show_all();
        this.notify("numbers");
    },

    get deviceId () {
        return this.device.id;
    },

    get numbers () {
        return Array.from(this.recipients.keys()).sort();
    },

    _setHeaderBar: function () {
        if (this.recipients.size) {
            let firstRecipient = this.recipients.values().next().value;

            if (firstRecipient.name) {
                this.headerBar.set_title(firstRecipient.name);
                this.headerBar.set_subtitle(firstRecipient.number);
            } else {
                this.headerBar.set_title(firstRecipient.number);
                this.headerBar.set_subtitle(null);
            }

            if (this.recipients.size > 1) {
                let num = this.recipients.size - 1;

                this.headerBar.set_subtitle(
                    Gettext.ngettext(
                        "And one other person",
                        "And %d other people",
                        num
                    ).format(num)
                );
            }

            let people = [];

            for (let recipient of this.recipients.values()) {
                people.push(recipient.name || recipient.number);
            }

            this.headerBar.set_tooltip_text(
                // TRANSLATORS: eg. SMS Conversation with John, Paul, George, Ringo
                _("SMS Conversation with %s").format(people.join(", "))
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

        this.messagesButton.visible = (this.recipients.size);
        this.contactButton.visible = false;
        this.stack.set_visible_child_name("contacts");
    },

    _showMessages: function () {
        this.headerBar.custom_title = null;
        this.contactEntry.text = "";

        this.messagesButton.visible = false;
        this.contactButton.visible = true;
        this.messageView.entry.has_focus = true;
        this.stack.set_visible_child_name("messages");
    },

    /**
     * Add a contact to the list of message recipients
     *
     * @param {object} contact - An object in the form of ContactsCache contacts
     * @return {object} - The recipient object
     */
    addRecipient: function (contact) {
        let plugin = this.device._plugins.get("telephony");
        let strippedNumber = contact.number.replace(/\D/g, "");

        // Get data from the cache
        let recipient = Object.assign(
            contact,
            plugin._cache.getContact(contact.number, contact.name || "")
        );

        // This is an extant recipient
        if (this.recipients.has(strippedNumber)) {
            recipient = Object.assign(
                this.recipients.get(strippedNumber),
                recipient
            );

            this.recipients.set(strippedNumber, recipient);
        // This is a new recipient
        } else {
            this.recipients.set(strippedNumber, recipient);

            // TODO: cleanup
            let found = false;

            for (let row of this.contactList.list.get_children()) {
                if (row._name.label === recipient.name) {
                    for (let numRow of row.numbers.get_children()) {
                        if (numRow.contact.number.replace(/\D/g, "") === strippedNumber) {
                            numRow.recipient.active = true;
                            found = true;
                        }
                    }
                }
            }

            if (!found) {
                this.contactList.addNumber(recipient);
            }

            this.notify("numbers");
        }

        return recipient;
    },

    /**
     * Remove a contact from the list of message recipients
     *
     * @param {object} contact - A contact object with at least a number
     */
    removeRecipient: function (contact) {
        let strippedNumber = contact.number.replace(/\D/g, "");

        if (this.recipients.has(strippedNumber)) {
            this.recipients.delete(strippedNumber);
            this.notify("numbers");
        }
    },

    /**
     * Return the Map() of current recipients
     */
    getRecipients: function () {
        return this.recipients;
    },

    /** Log an incoming message in the MessageList */
    receive: function (phoneNumber, contactName, messageBody) {
        let recipient = this.addRecipient({
            number: phoneNumber,
            name: contactName
        });

        this.messageView.addMessage(
            recipient,
            messageBody,
            MessageDirection.IN
        );
    },

    /** Send the contents of MessageView.entry to each recipient */
    send: function (entry, signal_id, event) {
        if (!entry.text.length) {
            return;
        }

        let plugin = this.device._plugins.get("telephony");

        // Send to each number
        for (let recipient of this.recipients.values()) {
            plugin.sendSms(recipient.number, entry.text);
        }

        // Log the outgoing message
        this.messageView.addMessage(
            { number: "0", color: "contact-color-outgoing" },
            entry.text,
            MessageDirection.OUT
        );
        entry.text = "";
    },

    setEntry: function (text) {
        this.messageView.entry.text = text;
        this.messageView.entry.emit("move-cursor", 0, text.length, false);
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
        this.set_titlebar(
            new Gtk.HeaderBar({
                title: _("Share Link"),
                subtitle: url,
                show_close_button: true,
                tooltip_text: url
            })
        );

        let grid = new Gtk.Grid({
            margin: 6,
            orientation: Gtk.Orientation.VERTICAL,
            column_homogeneous: true,
            column_spacing: 6,
            row_spacing: 6
        });
        this.add(grid);

        // Conversations
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        grid.attach(scrolledWindow, 0, 0, 2, 1);

        this.list = new Gtk.ListBox();
        this.list.connect("selected-rows-changed", () => {
            if (this.list.get_selected_rows().length) {
                this.sendButton.sensitive = true;
            } else {
                this.sendButton.sensitive = false;
            }
        });
        scrolledWindow.add(this.list);

        // New
        this.newButton = new Gtk.Button({
            label: _("New Message")
        });
        this.newButton.connect("clicked", () => {
            let window = new ConversationWindow(this.device);
            window.setEntry(url);
            this.destroy();
            window.present();
        });
        grid.attach(this.newButton, 0, 1, 1, 1);

        // Send
        this.sendButton = new Gtk.Button({
            label: _("Send"),
            sensitive: false
        });
        this.sendButton.connect("clicked",() => {
            let window = this.list.get_selected_row().window_;
            window.setEntry(url);
            this.destroy();
            window.present();
        });
        grid.attach(this.sendButton, 1, 1, 1, 1);

        // Filter Setup
        this._addWindows();
        this.show_all();
    },

    _addWindows: function () {
        let windows = this.device.daemon.get_windows();

        for (let index_ in windows) {
            let window = windows[index_];

            if (window.deviceId === this.device.id && window.numbers.length) {
                let recipients = window.getRecipients();
                let firstRecipient = recipients.values().next().value;

                let row = new Gtk.ListBoxRow();
                row.window_ = window;
                this.list.add(row);

                let grid = new Gtk.Grid({
                    margin: 6,
                    column_spacing: 6
                });
                row.add(grid);

                grid.attach(getAvatar(firstRecipient), 0, 0, 1, 2);

                let name = new Gtk.Label({
                    label: firstRecipient.name,
                    halign: Gtk.Align.START
                });
                grid.attach(name, 1, 0, 1, 1);

                let number = new Gtk.Label({
                    label: firstRecipient.number,
                    halign: Gtk.Align.START
                });
                number.get_style_context().add_class("dim-label");
                grid.attach(number, 1, 1, 1, 1);

                if (recipients.size > 1) {
                    let num = recipients.size - 1;

                    number.label = Gettext.ngettext(
                        "And one other person",
                        "And %d other people",
                        num
                    ).format(num);

                    let people = [];

                    for (let recipient of recipients.values()) {
                        people.push(recipient.name || recipient.number);
                    }

                    row.tooltip_text = _("SMS Conversation with %s").format(people.join(", "))
                }

                row.show_all();
            }
        }
    }
});

