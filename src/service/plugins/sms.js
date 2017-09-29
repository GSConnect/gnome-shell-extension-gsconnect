/**
 * sms.js - A simple dialog for sending SMS messages with GSConnect/KDE Connect
 * with (optional) Google Contacts auto-completion via Gnome Online Accounts.
 *
 * A great deal of credit and appreciation is owed to the indicator-kdeconnect
 * developers for the sister Python script 'Sms.py':
 * 
 * https://github.com/Bajoja/indicator-kdeconnect/blob/master/src/sms/Sms.py
 */

const Lang = imports.lang;
const System = imports.system;
const Gettext = imports.gettext.domain("gnome-shell-extension-gsconnect");
const _ = Gettext.gettext;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

try {
    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    var GData = undefined;
    var Goa = undefined;
}

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

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Client = imports.client;
const { initTranslations, Me, Resources, Settings } = imports.common;

initTranslations();

/** Phone Number types that support receiving texts */

/** A Gtk.EntryCompletion subclass for Google Contacts */
var ContactCompletion = new Lang.Class({
    Name: "ContactCompletion",
    Extends: Gtk.EntryCompletion,
    Properties: {
        "provider": GObject.ParamSpec.string(
            "provider",
            "ContactsProvider",
            "The provider for contacts",
            GObject.ParamFlags.READWRITE,
            "none"
        )
    },
    
    _init: function () {
        this.parent();
        
        // Track suggested completions
        this._matched = [];
        this._last = null;
        
        // Phone number icons
        let theme = Gtk.IconTheme.get_default()
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
        listStore.set_sort_func(1, this._levenshtein, null, null);
        this.set_model(listStore);
        
        // Title
        this.set_text_column(0);
        // Type Icon
        let typeCell = new Gtk.CellRendererPixbuf();
        this.pack_start(typeCell, false);
        this.add_attribute(typeCell, "pixbuf", 3);
        
        this.set_match_func(Lang.bind(this, this._match), null, null);
        this.connect("match-selected", Lang.bind(this, this._select));
        
        this._get_contacts();
    },
    
    /** Spawn folks.py */
    _get_contacts: function () {
        let envp = GLib.get_environ();
        envp.push("FOLKS_BACKENDS_DISABLED=telepathy")
        
        let [res, pid, in_fd, out_fd, err_fd] = GLib.spawn_async_with_pipes(
            null,                                   // working dir
            ["python3", Me.path + "/folks.py"],     // argv
            envp,                                   // envp
            GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
            null                                    // child_setup (func)
        );
        
        this._check_folks(err_fd, out_fd);
    },
    
    /** Check spawned folks.py for errors on stderr */
    _check_folks: function (err_fd, out_fd) {
        let errstream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: err_fd })
        });
    
        errstream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [errline, length] = source.read_line_finish(res);
            
            if (errline === null) {
                let stream = new Gio.DataInputStream({
                    base_stream: new Gio.UnixInputStream({ fd: out_fd })
                });
                
                this.provider = "avatar-default-symbolic";
                this.notify("provider");
                
                this._read_folk(stream)
            } else {
                log("Folks: " + errline);
                
                try {
                    for (let account in this._get_google_accounts()) {
                        this._get_google_contacts(account);
                        this.provider = "goa-account-google";
                        this.notify("provider");
                    }
                } catch (e) {
                    log("Google: " + e.message);
                }
            }
        });
        
    },
    
    /** Read a folk from folks.py output */
    _read_folk: function (stream) {
        stream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [contact, length] = source.read_line_finish(res);
            
            if (contact !== null) {
                let [name, number, type] = contact.toString().split("\t");
                this._add_contact(name, number, type);
                this._read_folk(stream);
            }
        });
    },
    
    /** Get all google accounts in Goa */
    _get_google_accounts: function () {
        let goaClient = Goa.Client.new_sync(null, null);
        let goaAccounts = goaClient.get_accounts();
        
        for (let goaAccount in goaAccounts) {
            let acct = goaAccounts[goaAccount].get_account();
            
            if (acct.provider_type === "google") {
                yield new GData.ContactsService({
                    authorizer: new GData.GoaAuthorizer({
                        goa_object: goaClient.lookup_by_id(acct.id)
                    })
                })
            }
        }
    },
    
    /** Query google contacts via GData */
    _get_google_contacts: function (account) {
        let query = new GData.Query({ q: "" });
        let count = 0;
        
        while (true) {
            let feed = account.query_contacts(
                query, // query,
                null, // cancellable
                (contact) => {
                    for (let phoneNumber of contact.get_phone_numbers()) {
                        this._add_contact(
                            contact.title,
                            phoneNumber.number,
                            phoneNumber.relation_type
                        );
                    }
                },
                null
            );
            
            count += feed.items_per_page;
            query.start_index = count;
            
            if (count > feed.total_results) { break; }
        }
    },
    
    /** Add contact */
    _add_contact: function (name, number, type) {
        // Only include types that could possibly support SMS
        if (SUPPORTED_NUMBER_TYPES.indexOf(type) < 0) { return; }
    
        // Append the number to the title column
        let title = name + " <" + number + ">";
        
        // Phone Type Icon
        if (type.indexOf("home") > -1) {
            type = this.phone_number_home;
        } else if (type.indexOf("cell") > -1 || type.indexOf("mobile") > -1) {
            type = this.phone_number_mobile;
        } else if (type.indexOf("work") > -1 || type.indexOf("voice") > -1) {
            type = this.phone_number_work;
        } else {
            type = this.phone_number_default;
        }
    
        this.model.set(
            this.model.append(),
            [0, 1, 2, 3],
            [title, name, number, type]
        );
    },
    
    /** Multi-recipient capable match function */
    _match: function (completion, key, tree_iter) {
        let model = completion.get_model();
        let title = model.get_value(tree_iter, 0).toLowerCase();
        let name = model.get_value(tree_iter, 1).toLowerCase();
        let number = model.get_value(tree_iter, 2);
        
        let currentContacts = key.split(";").slice(0, -1);
        
        // Set key to the last or only search item, trimmed of whitespace
        if (key.indexOf(";") > -1) { key = key.split(";").pop().trim(); }
        
        // Return if the possible match is in the current list
        if (currentContacts.indexOf(title) > -1) { return false; }
        
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
        let currentContacts = entry.text.split(";").slice(0, -1);
        let selectedContact = model.get_value(tree_iter, 0);
        
        // Return if this contact is already in the current list
        if (currentContacts.indexOf(selectedContact) > -1) { return; }
        
        entry.set_text(
            currentContacts.join("; ")
            + ((currentContacts.length) ? "; " : "")
            + selectedContact + "; "
        );
        
        entry.set_position(-1);
        this._matched = [];
        
        return true;
    },
    
    /** 
     * A levenshtein sort function
     * See: https://gist.github.com/andrei-m/982927#gistcomment-2059365
     */
    _levenshtein: function (model, a, b, user_data) {
	    var tmp;
	    if (a.length === 0) { return b.length; }
	    if (b.length === 0) { return a.length; }
	    if (a.length > b.length) { tmp = a; a = b; b = tmp; }

	    var i, j, res, alen = a.length, blen = b.length, row = Array(alen);
	    for (i = 0; i <= alen; i++) { row[i] = i; }

	    for (i = 1; i <= blen; i++) {
		    res = i;
		    for (j = 1; j <= alen; j++) {
			    tmp = row[j - 1];
			    row[j - 1] = res;
			    res = b[i - 1] === a[j - 1] ? tmp : Math.min(tmp + 1, Math.min(res + 1, row[j] + 1));
		    }
	    }
	    
	    return res;
    }
});


/** A Gtk.Entry subclass for contact names and phone numbers */
var ContactEntry = new Lang.Class({
    Name: "ContactEntry",
    Extends: Gtk.SearchEntry,
    
    _init: function (completion) {
        this.parent({
            hexpand: true,
            placeholder_text: _("Type a phone number"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            completion: completion
        });
        
        // FIXME: might already be setup
        this.completion.connect("notify::provider", (completion) => {
            this.placeholder_text = _("Type a phone number or name");
            this.primary_icon_name = this.completion.provider;
            this.input_purpose = Gtk.InputPurpose.FREE_FORM;
        });
    
        // Select the first completion suggestion on "activate"
        this.connect("activate", () => { this._select(this); });
        
        // Workaround for empty searches not calling CompletionMatchFunc
        this.connect("changed", (entry) => {
            let styleContext = entry.get_style_context();
            
            if (entry.text === "") {
                let completion = entry.get_completion();
                completion._matched = [];
                completion._last = null;
            } else if (styleContext.has_class("error")) {
                styleContext.remove_class("error");
            }
        });
    },
    
    _select: function (entry) {
        let completion = entry.get_completion();
        
        if (completion._matched.length > 0) {
            let iter_path = completion._matched["0"];
            let [b, iter] = completion.model.get_iter_from_string(iter_path);
            let oldContacts = entry.text.split(";").slice(0, -1);
            let newContact = completion.model.get_value(iter, 0);
        
            // Ignore duplicate selections
            if (oldContacts.indexOf(newContact) > -1) { return; }
        
            entry.set_text(
                oldContacts.join("; ")
                + ((oldContacts.length) ? "; " : "")
                + newContact + "; "
            );
        
            entry.set_position(-1);
            completion._matched = [];
        }
    }
});


/** SMS Window */
var ApplicationWindow = new Lang.Class({
    Name: "ApplicationWindow",
    Extends: Gtk.ApplicationWindow,
    
    _init: function(application, device) {
        this.parent({
            application: application,
            title: "GSConnect",
            default_width: 300,
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        this.plugin = this.device._plugins.get("telephony");
        
        // Contact Entry
        this.contactEntry = new ContactEntry(new ContactCompletion());
        this.device.bind_property(
            "connected",
            this.contactEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        
        // HeaderBar
        this.set_titlebar(
            new Gtk.HeaderBar({
                custom_title: this.contactEntry,
                show_close_button: true
            })
        );
        
        // Content
        this.layout = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        this.add(this.layout);
        
        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({ label: _("Device is offline") })
        );
        
        // Content -> Conversation View
        // TODO: use a listbox/bubbles to indicate msg direction
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true
        });
        this.layout.add(scrolledWindow);
        
        let conversationFrame = new Gtk.Frame();
        scrolledWindow.add(conversationFrame);
        
        this.conversationBuffer = new Gtk.TextBuffer();
        
        let conversationView = new Gtk.TextView({
            hexpand: true,
            vexpand: true,
            cursor_visible: false,
            editable: false,
            wrap_mode: Gtk.WrapMode.WORD,
            buffer: this.conversationBuffer
        });
        
        this.device.bind_property(
            "connected",
            conversationView,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        conversationFrame.add(conversationView);
        
        // Content -> Message Entry
        this.messageEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            secondary_icon_name: "sms-send",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        
        this.messageEntry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length) ? true : false;
        });
        
        this.messageEntry.connect("activate", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.messageEntry.connect("icon-release", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.device.bind_property(
            "connected",
            this.messageEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        
        this.layout.add(this.messageEntry);
        
        // Device Status
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        this.device.connect("notify::connected", () => {
            if (!this.device.connected) {
                this.layout.add(this.infoBar);
                this.layout.reorder_child(this.infoBar, 0);
                this.infoBar.show_all();
            } else if (this.device.connected) {
                this.infoBar.hide();
                this.layout.remove(this.infoBar);
            }
        });
        
        // Connect to notifications
        this.plugin.connect("sms", Lang.bind(this, this._catch_message));
        
        // Finish initing
        this.show_all();
        this.has_focus = true;
    },
    
    // FIXME:
    _catch_message: function (plugin, phoneNumber, contactName, messageBody, phoneThumbnail) {
        log("SMS phoneNumber: " + phoneNumber);
        log("SMS contactName: " + contactName);
        log("SMS messageBody: " + messageBody);
        log("SMS phoneThumbnail: " + phoneThumbnail);
        let recipients = this._get_recipients();
        
        // Check for a verbatim match
        if (recipients.has(contactName)) {
            log("Matched incoming sender");
            this._log_message(contactName, messageBody);
            this.urgency_hint = true;
        // Might be just a number, strip both down to digits and check
        } else {
            for (let [name, number] of recipients.entries()) {
                let local_num = number.replace(/\D/g, "");
                let remote_num = phoneNumber.replace(/\D/g, "");
                
                if (local_num === remote_num) {
                    log("Matched incoming number");
                    this._log_message(name, messageBody);
                    this.urgency_hint = true;
                }
            }
        }
    },
    
    _get_recipients: function () {
        let contactItems = this.contactEntry.text.split(";").filter((s) => {
            return /\S/.test(s);
        });
        let recipients = new Map();
        let model = this.contactEntry.get_completion().get_model();
        
        for (let item of contactItems) {
            item = item.trim();
            let contact = false;
            
            // Search the completion for a matching 
            model.foreach((model, path, tree_iter) => {
                if (item === model.get_value(tree_iter, 0)) {
                    contact = [
                        model.get_value(tree_iter, 1),
                        model.get_value(tree_iter, 2)
                    ];
                    log("found recipient (name): \"" + contact[0] + "\"");
                    log("found recipient (num): \"" + contact[1] + "\"");
                    return true;
                }
                
                contact = false;
            });
            
            if (contact) {
                recipients.set(contact[0], contact[1]);
            } else {
                recipients.set(item, item);
            }
        }
        
        return recipients;
    },
    
    _get_numbers: function () {
        let contactItems = this.contactEntry.text.split(";").filter((s) => {
            return /\S/.test(s);
        });
        let numbers = [];
        let model = this.contactEntry.get_completion().get_model();
        
        for (let item of contactItems) {
            item = item.trim();
            let number = false;
            
            // Search the completion for an exact contact match
            model.foreach((model, path, tree_iter) => {
                if (item === model.get_value(tree_iter, 0)) {
                    number = model.get_value(tree_iter, 2);
                    return true;
                }
                
                number = false;
            });
            
            // Found a matching Contact
            if (number) {
                numbers.push(number);
            // Anything else can be handled by the device (libphonenumber)
            } else {
                numbers.push(item);
            }
        }
        
        return numbers;
    },
    
    _log_message: function (name, message) {
        let item = "<b>" + name + ":</b> " + message + "\n";
        
        this.conversationBuffer.insert_markup(
            this.conversationBuffer.get_end_iter(),
            item,
            item.length
        );
    },
    
    /** Return a list of phone numbers that the SMS will be sent to */
    send: function (entry, signal_id, event) {
        let numbers = this._get_numbers();
        
        // Check a number/contact has been provided
        if (!numbers.length) {
            this.contactEntry.has_focus = true;
            this.contactEntry.secondary_icon_name = "dialog-error-symbolic";
            let styleContext = this.contactEntry.get_style_context();
            
            if (!styleContext.has_class("error")) {
                styleContext.add_class("error");
            }
            
            return false;
        }
        
        // Send to each number
        for (let number of numbers) {
            this.plugin.sms(number, entry.text);
        }
        
        // Log the sent message in the Conversation View and clear the entry
        this._log_message(_("You"), entry.text);
        entry.text = "";
    }
});

