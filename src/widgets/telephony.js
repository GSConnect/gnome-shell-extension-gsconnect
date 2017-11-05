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

try {
    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    var GData = undefined;
    var Goa = undefined;
}

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent();
    return p.get_path();
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
// TODO: MessageStyle.load_from_resource("/style/sms.css");
MessageStyle.load_from_data(
    ".contact-avatar { border-radius: 16px; } " +
    ".message-bubble { border-radius: 1em; } " +
    
    ".contact-color-red { color: #ffffff; background-color: #cc0000; } " +
    ".contact-color-orange { color: #000000; background-color: #f57900; } " +
    ".contact-color-yellow { color: #000000; background-color: #edd440; } " +
    ".contact-color-green { color: #ffffff; background-color: #4e9a06; } " +
    ".contact-color-blue { color: #ffffff; background-color: #204a87; } " +
    ".contact-color-purple { color: #ffffff; background-color: #5c3566; } " +
    ".contact-color-brown { color: #ffffff; background-color: #8f5902; } " +
    ".contact-color-grey { color: #ffffff; background-color: #2e3436; } " +
    ".contact-color-outgoing { color: #000000; background-color: #d3d7cf; } "
);


var shuffleColor = Array.shuffler([
    "contact-color-red",
    "contact-color-orange",
    "contact-color-yellow",
    "contact-color-green",
    "contact-color-blue",
    "contact-color-purple",
    "contact-color-brown",
    "contact-color-grey"
]);

var LINK_REGEX = /\b((?:https?:\/\/|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/gi;
        
        
/** A Gtk.EntryCompletion subclass for Google Contacts */
var ContactCompletion = new Lang.Class({
    Name: "GSConnectContactCompletion",
    Extends: Gtk.EntryCompletion,
    
    _init: function (cache) {
        this.parent();
        
        this._cache = cache;
        
        // Track suggested completions
        this._matched = [];
        this._last = null;
        
        // Phone number icons
        let theme = Gtk.IconTheme.get_default();
        this.phone_number_default = theme.load_icon("phone-number-default", 0, 0);
        this.phone_number_home = theme.load_icon("phone-number-home", 0, 0);
        this.phone_number_mobile = theme.load_icon("phone-number-mobile", 0, 0);
        this.phone_number_work = theme.load_icon("phone-number-work", 0, 0);
        
        // Define a completion model
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // Title ("Name <Phone Number>")
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING,    // Phone Number
            GdkPixbuf.Pixbuf        // Type Icon
        ]);
        listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
        listStore.set_sort_func(0, this._sort);
        this.set_model(listStore);
        
        // Title
        this.set_text_column(0);
        // Type Icon
        let typeCell = new Gtk.CellRendererPixbuf();
        this.pack_start(typeCell, false);
        this.add_attribute(typeCell, "pixbuf", 3);
        
        this.set_match_func(Lang.bind(this, this._match));
        this.connect("match-selected", Lang.bind(this, this._select));
        
        this._read_cache();
    },
    
    /** Spawn folks.py */
    _read_cache: function () {
        for (let contact of this._cache.contacts) {
            this._add_contact(contact);
        }
    },
    
    /** Add contact */
    _add_contact: function (contact) {
        // Only include types that could possibly support SMS
        if (SUPPORTED_NUMBER_TYPES.indexOf(contact.type) < 0) { return; }
    
        // Append the number to the title column
        let title = contact.name + " <" + contact.number + ">";
        
        // Phone Type Icon
        let icon;
        
        if (contact.type.indexOf("home") > -1) {
            icon = this.phone_number_home;
        } else if (contact.type.indexOf("cell") > -1 || contact.type.indexOf("mobile") > -1) {
            icon = this.phone_number_mobile;
        } else if (contact.type.indexOf("work") > -1 || contact.type.indexOf("voice") > -1) {
            icon = this.phone_number_work;
        } else {
            icon = this.phone_number_default;
        }
    
        this.model.set(
            this.model.append(),
            [0, 1, 2, 3],
            [title, contact.name, contact.number, icon]
        );
    },
    
    /** Multi-recipient capable match function */
    _match: function (completion, key, tree_iter) {
        let model = completion.get_model();
        let name = model.get_value(tree_iter, 1).toLowerCase();
        let number = model.get_value(tree_iter, 2);
        let recipients = this.get_entry()._parent._recipients;
        
        // Return if the possible match is in the current recipients
        if (recipients.has(number.replace(/\D/g, ""))) { return false; }
        
        // Clear current matches, reset last key and return if the key is empty
        if (!key.length) {
            this._matched = [];
            this._last = null;
            return;
        // Clear current matches and reset last key if the key has changed
        } else if (key !== this._last) {
            this._matched = [];
            this._last = key;
        }
        
        if (this._matched.length >= 20) { return false; }
        
        // Match name or number
        if (name.indexOf(key) > -1 || number.indexOf(key) > -1) {
            this._matched.push(model.get_string_from_iter(tree_iter));
            return true;
        }
    },
    
    /** Add selected auto-complete entry to list of contacts in the entry */
    _select: function (completion, model, tree_iter) {
        let entry = completion.get_entry();
        this._matched = [];
        entry._parent.addRecipient(
            model.get_value(tree_iter, 2),
            model.get_value(tree_iter, 1)
        );
        entry.text = "";
        
        return true;
    },
    
    _sort: function (model, a, b, user_data) {
        return model.get_value(a, 0).localeCompare(model.get_value(b, 0));
    }
});


/**
 * A Gtk.Entry subclass for contact names and phone numbers
 */
var ContactEntry = new Lang.Class({
    Name: "GSConnectContactEntry",
    Extends: Gtk.Entry,
    
    _init: function (window, completion) {
        this.parent({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            completion: completion
        });
        
        this._parent = window;
        this._parent.plugin._cache.bind_property(
            "provider",
            this,
            "primary-icon-name",
            GObject.BindingFlags.SYNC_CREATE
        );
    
        // Select the first completion suggestion on "activate"
        this.connect("activate", () => { this._select(this); });
        
        // Workaround for empty searches not calling CompletionMatchFunc
        this.connect("changed", (entry) => {
            if (!entry.text.length) {
                let completion = entry.get_completion();
                completion._matched = [];
                completion._last = null;
            }
        });
        
        this.connect("activate", (entry) => {
            this._select(this);
        });
        
        this.connect("key-press-event", (entry, event, user_data) => {
            if (event.get_keyval()[1] === Gdk.KEY_Escape) {
                entry.text = "";
                this._select(this);
            }
        });
    },
    
    _select: function (entry) {
        let completion = entry.get_completion();
        
        if (completion._matched.length > 0) {
            let iter_path = completion._matched["0"];
            let [b, iter] = completion.model.get_iter_from_string(iter_path);
            
            completion._matched = [];
            
            this._parent.addRecipient(
                completion.model.get_value(iter, 2),
                completion.model.get_value(iter, 1)
            );
            entry.text = "";
        } else if (entry.text.length) {
            this._parent.addRecipient(entry.text);
            entry.text = "";
        } else {
            this._parent.notify("recipients");
        }
    }
});


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


var RecipientList = new Lang.Class({
    Name: "GSConnectRecipientList",
    Extends: Gtk.ScrolledWindow,
    
    _init: function (window) {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            margin: 6
        });
        
        this._parent = window;
        
        let recipientFrame = new Gtk.Frame();
        this.add(recipientFrame);
        
        this.list = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        recipientFrame.add(this.list);
        
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
    },
    
    /**
     * Add a new recipient, ...
     *
     * @param {object} recipient - The recipient object for this person
     */
    addRecipient: function (recipient) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        this.list.add(row);
        
        row.layout = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 12,
            row_spacing: 0
        });
        row.add(row.layout);
        
        // ContactAvatar
        row.avatar = this._parent._getAvatar(recipient);
        row.layout.attach(row.avatar, 0, 0, 1, 2);
        
        // contactName
        row.contact = new Gtk.Label({
            label: recipient.name || _("Unknown Contact"),
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true
        });
        row.layout.attach(row.contact, 1, 0, 1, 1);
        
        // phoneNumber
        row.phone = new Gtk.Label({
            label: recipient.number || _("Unknown Number"),
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true
        });
        row.phone.get_style_context().add_class("dim-label");
        row.layout.attach(row.phone, 1, 1, 1, 1);
        
        let removeButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "edit-delete-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        removeButton.get_style_context().add_class("circular");
        removeButton.connect("clicked", () => {
            this._parent.removeRecipient(recipient.number.replace(/\D/g, ""));
            this.list.remove(row);
        });
        row.layout.attach(removeButton, 2, 0, 1, 2);
        
        row.show_all();
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
        let frame = new Gtk.Frame();
        this.add(frame);
        
        this.threadWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        frame.add(this.threadWindow);
        
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
        row.avatar = this._parent._getAvatar(recipient);
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
        messageBubbleStyle.add_class((direction) ? recipient.color : "contact-color-outgoing");
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
        "recipients": GObject.param_spec_variant(
            "recipients",
            "RecipientList", 
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    
    _init: function(application, device) {
        this.parent({
            application: application,
            title: _("SMS Conversation"),
            default_width: 300,
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        this.plugin = this.device._plugins.get("telephony");
        this._recipients = new Map();
        this._notifications = [];
        
        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect("notify::recipients", () => { this._setHeaderBar(); });
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
        this.contactButton.connect("clicked", () => {
            this._showRecipients();
        });
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
        
        // Contact Entry
        this.contactEntry = new ContactEntry(
            this,
            new ContactCompletion(this.plugin._cache)
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
        
        // Recipient List
        this.recipientList = new RecipientList(this);
        this.stack.add_named(this.recipientList, "recipients");
        
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
        this.notify("recipients");
    },
    
    _setHeaderBar: function () {
        if (this._recipients.size) {
            let firstRecipient = this._recipients.values().next().value;
            
            if (firstRecipient.name) {
                this.headerBar.set_title(firstRecipient.name);
                this.headerBar.set_subtitle(firstRecipient.number);
            } else {
                this.headerBar.set_title(firstRecipient.number);
                this.headerBar.set_subtitle(null);
            }
            
            if (this._recipients.size > 1) {
                let num = this._recipients.size - 1;
                
                this.headerBar.set_subtitle(
                    Gettext.ngettext(
                        "And one other person",
                        "And %d other people",
                        num
                    ).format(num)
                );
            }
                
            let people = [];
            
            for (let recipient of this._recipients.values()) {
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
            this._showRecipients();
        }
    },
    
    _showRecipients: function () {
        this.headerBar.custom_title = this.contactEntry;
        this.contactEntry.has_focus = true;
        
        this.messagesButton.visible = (this._recipients.size);
        this.contactButton.visible = false;
        this.stack.set_visible_child_name("recipients");
    },
    
    _showMessages: function () {
        this.headerBar.custom_title = null;
        
        this.messagesButton.visible = false;
        this.contactButton.visible = true;
        this.messageView.entry.has_focus = true;
        this.stack.set_visible_child_name("messages");
    },
    
    get recipients () {
        return Array.from(this._recipients.keys());
    },
    
    _getAvatar: function (recipient) {
        // TODO: GdkPixbuf chokes hard on non-fatally corrupted images
        let avatar;
        
        if (recipient.avatar) {
            try {
                avatar = new ContactAvatar({ path: recipient.avatar });
            } catch (e) {
                Common.debug("Error creating avatar: " + e);
                avatar = this._getDefaultAvatar(recipient);
            }
        } else {
            avatar = this._getDefaultAvatar(recipient);
        }
        
        return avatar;
    },
    
    _getDefaultAvatar: function (recipient) {
        let avatar = new Gtk.Box({ width_request: 32, height_request: 32 });
        let avatarStyle = avatar.get_style_context();
        avatarStyle.add_provider(MessageStyle, 0);
        avatarStyle.add_class("contact-avatar");
        avatarStyle.add_class(recipient.color);
        
        let defaultAvatar = new Gtk.Image({
            icon_name: "avatar-default-symbolic",
            pixel_size: 24,
            margin: 4,
            visible: true
        });
        avatar.add(defaultAvatar);
        
        return avatar;
    },
    
    /**
     * Add a contact to the list of recipients
     *
     * @param {string} phoneNumber - The contact's phone number
     * @param {string} [contactName] - The contact's name
     * @return {object} - The recipient object
     */
    addRecipient: function (phoneNumber, contactName) {
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        let recipient = {
            number: phoneNumber,
            name: contactName
        };
        
        // Get data from the cache
        recipient = Object.assign(
            recipient,
            this.plugin._cache.getContact(strippedNumber, recipient.name)
        );
        
        // This is an extant recipient
        if (this._recipients.has(strippedNumber)) {
            recipient = Object.assign(
                this._recipients.get(strippedNumber),
                recipient
            );
            
            this._recipients.set(strippedNumber, recipient);
        // This is a new recipient
        } else {
            recipient.color = shuffleColor(); // Only do this once per recipient
            this._recipients.set(strippedNumber, recipient);
            this.recipientList.addRecipient(recipient);
        }
        
        this.notify("recipients");
        return recipient;
    },
    
    /** Remove a contact by phone number from the list of recipients */
    removeRecipient: function (phoneNumber) {
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        
        if (this._recipients.has(strippedNumber)) {
            this._recipients.delete(strippedNumber);
            this.notify("recipients");
        }
    },
    
    /** Log an incoming message in the MessageList */
    receive: function (phoneNumber, contactName, messageBody) {
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        
        let recipient = this.addRecipient(
            phoneNumber,
            contactName
        );
    
        this.messageView.addMessage(
            recipient,
            messageBody,
            MessageDirection.IN
        );
            
        this.recipientList.list.foreach((row) => {
            if (row.phone.label.replace(/\D/g, "") === strippedNumber) {
                row.layout.remove(row.avatar);
                row.avatar = this._getAvatar(recipient);
                row.avatar.visible = true;
                row.layout.attach(row.avatar, 0, 0, 1, 2);
            }
        });
    },
    
    /** Send the contents of ContactEntry to each recipient */
    send: function (entry, signal_id, event) {
        // Send to each number
        for (let number of this.recipients) {
            this.plugin.sendSms(number, entry.text);
        }
        
        // Log the outgoing message
        this.messageView.addMessage(
            { number: "0", color: "contact-color-grey" },
            entry.text,
            MessageDirection.OUT
        );
        entry.text = "";
    }
});

