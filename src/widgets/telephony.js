"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


/**
 * Phone Number types that support receiving texts
 */
const SUPPORTED_NUMBER_TYPES = [
    // GData: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
    "http://schemas.google.com/g/2005#home",
    "http://schemas.google.com/g/2005#main",
    "http://schemas.google.com/g/2005#mobile",
    "http://schemas.google.com/g/2005#other",
    "http://schemas.google.com/g/2005#pager",
    "http://schemas.google.com/g/2005#work",
    "http://schemas.google.com/g/2005#work_mobile",
    "http://schemas.google.com/g/2005#work_pager",
    // Folks: http://www.ietf.org/rfc/rfc2426.txt
    "home",
    "cell",     // Equal to GData->mobile
    "pager",
    "pref",     // Equal to GData->main
    "work",
    "voice"     // Sometimes mapped from GData#work
];

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
var MessageStyle = new Gtk.CssProvider();
//MessageStyle.load_from_resource("/style/telephony.css");
MessageStyle.load_from_data(
    Common.Resources.lookup_data("/style/telephony.css", 0).toArray().toString()
);


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
    "contact-color-aluminium1",
    "contact-color-aluminium2",
    "contact-color-aluminium3"
]);

var LINK_REGEX = /\b((?:https?:\/\/|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/gi;


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
            Common.debug("Warning: " + e.message);
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

    
function getAvatar (recipient) {
    let avatar;
    
    if (recipient.avatar) {
        try {
            avatar = new ContactAvatar({ path: recipient.avatar });
        } catch (e) {
            Common.debug("Error creating avatar: " + e);
            avatar = getDefaultAvatar(recipient);
        }
    } else {
        avatar = getDefaultAvatar(recipient);
    }
    
    return avatar;
};


function getDefaultAvatar (recipient) {
    let avatar = new Gtk.Box({ width_request: 32, height_request: 32 });
    let avatarStyle = avatar.get_style_context();
    avatarStyle.add_provider(MessageStyle, 0);
    avatarStyle.add_class("contact-avatar");
    avatarStyle.add_class(recipient.color || shuffleColor());
    
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
        let row = new Gtk.ListBoxRow();
        
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
        
        row.numbers = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        grid.attach(row.numbers, 1, 1, 1, 1);
        
        this.list.add(row);
        
        return row;
    },
    
    addNumber: function (contact) {
        let contactRow = false;
        
        for (let row of this.list.get_children()) {
            if (contact.name !== _("Unknown Contact") && contact.name === row._name.label) {
                contactRow = row;
                break;
            }
        }
        
        if (!contactRow) {
            contactRow = this.addContact(contact);
        }
        
        let box = new Gtk.Box();
        box.contact = contact;
        contactRow.numbers.add(box);
        
        box._number = new Gtk.Label({
            label: contact.number || _("Unknown Number"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        box._number.get_style_context().add_class("dim-label");
        box.add(box._number);
        
        //
        box._type = new Gtk.Image({
            icon_name: "phone-number-default",
            pixel_size: 16
        });
        
        if (!contact.type) {
            box._type.icon_name = "phone-number-default";
        } else if (contact.type.indexOf("home") > -1) {
            box._type.icon_name = "phone-number-home";
        } else if (contact.type.indexOf("cell") > -1 || contact.type.indexOf("mobile") > -1) {
            box._type.icon_name = "phone-number-mobile";
        } else if (contact.type.indexOf("work") > -1 || contact.type.indexOf("voice") > -1) {
            box._type.icon_name = "phone-number-work";
        }
        box.add(box._type);
        
        box.recipient = new Gtk.CheckButton({
            active: false,
            margin_right: 12
        });
        box.recipient.connect("toggled", () => {
            this._toggle(contactRow, box);
        });
        box.add(box.recipient);
        
        contactRow.show_all();
        
        return contactRow;
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
    
    // FIXME
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
        
        this._parent.device.bind_property(
            "connected",
            this.entry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.add(this.entry);
    },
    
    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {object} recipient - The recipient object
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addThread: function (recipient, direction) {
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
        row.avatar = getAvatar(recipient);
        row.avatar.tooltip_text = recipient.name || recipient.number;
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
     * @param {string} recipient - The recipient object
     * @param {string} messageBody - The message content
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addMessage: function (recipient, messageBody, direction) {
        let sender = recipient.name || recipient.number;
        let nrows = this.list.get_children().length;
        let row, currentThread;
        
        if (nrows) {
            let currentThread = this.list.get_row_at_index(nrows - 1);
            
            if (currentThread.avatar.tooltip_text === sender) {
                row = currentThread;
            }
        }
        
        if (!row) {
            row = this.addThread(recipient, direction);
        }
        
        let messageBubble = new Gtk.Grid({
            visible: true,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        let messageBubbleStyle = messageBubble.get_style_context();
        messageBubbleStyle.add_provider(MessageStyle, 0);
        messageBubbleStyle.add_class("message-bubble");
        messageBubbleStyle.add_class(recipient.color);
        row.messages.add(messageBubble);
        
        let messageContent = new Gtk.Label({
            label: messageBody.replace(LINK_REGEX, '<a href="$1">$1</a>'),
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
                Gdk.CURRENT_TIME
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
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        this.recipients = new Map();
        this._notifications = [];
        
        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect("notify::numbers", () => { this._setHeaderBar(); });
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
        this.contactButton.connect("clicked", () => { this._showContacts(); });
        this.device.bind_property(
            "connected",
            this.contactButton,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.pack_start(this.contactButton);
        
        // Messages Button
        this.messagesButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "go-previous-symbolic",
                pixel_size: 16
            }),
            always_show_image: true
        });
        this.messagesButton.connect("clicked", () => {
            this.contactEntry.text = "";
            this._showMessages();
        });
        this.device.bind_property(
            "connected",
            this.messagesButton,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.pack_start(this.messagesButton);
        
        // Contact Entry // TODO: separate
        this.contactEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE
        });
        this.device._plugins.get("telephony")._cache.bind_property(
            "provider",
            this.contactEntry,
            "primary-icon-name",
            GObject.BindingFlags.SYNC_CREATE
        );
        this.device.bind_property(
            "connected",
            this.contactEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
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
            if (!this.device.connected) {
                this.layout.attach(this.infoBar, 0, 0, 1, 1);
                this.infoBar.show_all();
            } else if (this.device.connected) {
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
        this.device.bind_property(
            "connected",
            this.stack,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
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
        return Array.from(this.recipients.keys());
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
                if (recipient.name) {
                    people.push(recipient.name);
                } else {
                    people.push(recipient.number);
                }
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
        
        this.messagesButton.visible = false;
        this.contactButton.visible = true;
        this.messageView.entry.has_focus = true;
        this.stack.set_visible_child_name("messages");
    },
    
    /**
     * Add a contact to the list of recipients
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
            plugin._cache.getContact(strippedNumber, contact.name || "")
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
            recipient.color = shuffleColor(); // Only do this once per recipient
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
        }
        
        this.notify("numbers");
        return recipient;
    },
    
    /** Remove a contact by phone number from the list of recipients */
    removeRecipient: function (recipient) {
        let strippedNumber = recipient.number.replace(/\D/g, "");
        
        if (this.recipients.has(strippedNumber)) {
            this.recipients.delete(strippedNumber);
            this.notify("recipients");
        }
    },
    
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
        let plugin = this.device._plugins.get("telephony");
        
        // Send to each number
        for (let number of this.numbers) {
            plugin.sendSms(number, entry.text);
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
            default_height: 200,
            icon_name: "phone"
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
            let window = new TelephonyWidget.ConversationWindow(this.device);
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
            
            if (window.deviceId === this.device.id && window.numbers) {
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
            }
        }
    }
});

