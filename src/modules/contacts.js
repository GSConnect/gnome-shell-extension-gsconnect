"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


// TODO: folks, prefs check Contacts.GData, etc
try {
    imports.gi.versions.GData = "0.0";
    imports.gi.versions.Goa = "1.0";

    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    debug("Warning: Goa-1.0.typelib and GData-0.0.typelib required for Google contacts: " + e);
    var GData = undefined;
    var Goa = undefined;
}

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Color = imports.modules.color;


//
var CACHE_DIR = GLib.build_filenamev([gsconnect.cachedir, "_contacts"]);


// Return a singleton
var _contactsStore;

function getStore() {
    if (!_contactsStore) {
        _contactsStore = new Store();
    }

    return _contactsStore;
};

/**
 * Get Gdk.Pixbuf for @path, allowing for partially corrupt JPEG's KDE Connect
 * sometimes sends.
 *
 * @param {string} path - A local file path
 */
function getPixbuf(path) {
    let loader = new GdkPixbuf.PixbufLoader();
    loader.write(GLib.file_get_contents(path)[1]);

    try {
        loader.close();
    } catch (e) {
        debug("Warning: " + e.message);
    }

    return loader.get_pixbuf();
};


function mergeContacts(current, update) {
    let newContacts = {};

    for (let id in update) {
        let updateContact = update[id];

        if (current.hasOwnProperty(id)) {
            // FIXME: deep merge
            newContacts[id] = Object.assign(current[id], update[id]);
        } else {
            newContacts[id] = update[id];
        }

//        // Update contact
//        if (current.hasOwnProperty(id)) {
//            ["name", "origin", "avatar", "folk_id"].forEach(prop => {
//                current[id][prop] = update[id][prop] || current[id][prop];
//            });

//            for (let entry of updateContact.numbers) {
//                let found = false;

//                for (let centry of current[id].numbers) {
//                    if (entry.number === centry.number) {
//                        ["type", "uri"].forEach(prop => {
//                            centry[prop] = entry[prop] || centry[prop];
//                        });
//                        found = true;
//                        break;
//                    }
//                }

//                if (!found) {
//                    current[id].numbers.push(entry);
//                }
//            }
//        // New contact
//        } else {
//            current[id] = update[id];
//        }
    }

    return newContacts;
};


var Store = GObject.registerClass({
    GTypeName: "GSConnectContactsStore",
    Implements: [ Gio.ListModel ],
    Properties: {
        "contacts": GObject.param_spec_variant(
            "contacts",
            "ContactsList",
            "A list of cached contacts",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "provider-icon": GObject.ParamSpec.string(
            "provider-icon",
            "ContactsProvider",
            "The contact provider icon name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "provider-name": GObject.ParamSpec.string(
            "provider-name",
            "ContactsProvider",
            "The contact provider name (eg. Google)",
            GObject.ParamFlags.READABLE,
            ""
        )
    },
    Signals: {
        "destroy": { flags: GObject.SignalFlags.NO_HOOKS },
        "ready": { flags: GObject.SignalFlags.RUN_FIRST }
    }
}, class Store extends GObject.Object {

    _init() {
        super._init();

        // Init cache
        GLib.mkdir_with_parents(CACHE_DIR, 448);

        this._cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([CACHE_DIR, "contacts.json"])
        );

        // Read cache
        try {
            let cache = this._cacheFile.load_contents(null)[1];
            this._contacts = JSON.parse(cache);
        } catch (e) {
            debug("Cache: Error reading %s cache: " + e.message + "\n" + e.stack);
            this._contacts = {};
        }

        this.connect("notify::contacts", () => {
            //this.notify("items-changed");
            // FIXME
            this._writeCache()
        });

        this.update();
    }

    get contacts() {
        return Object.keys(this._contacts);
    }

    get provider_icon() {
        return this._provider_icon || "call-start-symbolic";
    }

    get provider_name() {
        return this._provider_name || _("GSConnect");
    }

    /**
     * Gio.ListModel interface
     */
    vfunc_get_item() {
    }

    vfunc_get_item_type() {
        return Contact;
    }

    vfunc_get_n_items() {
        return Object.keys(this._contacts).length;
    }

    /**
     * Addition ListModel-like function
     */
    add_item() {
        this.notify("contacts");
    }

    remove_item() {
        this.notify("contacts");
    }

    query(query) {
        let number = (query.number) ? query.number.replace(/\D/g, "") : null;

        let matches = {};

        for (let id in this._contacts) {
            let contact = this._contacts[id];

            // Prioritize searching by number
            if (number) {
                for (let num of contact.numbers) {
                    // Match by number stripped of non-digits
                    if (number === num.number.replace(/\D/g, "")) {
                        matches[id] = this._contacts[id];

                        // Number match & exact name match; must be it
                        if (query.name && query.name === contact.name) {
                            matches = {};
                            matches[id] = contact
                            return matches[id];
                        }
                    }
                }
            // Fallback to searching by exact name match
            } else if (query.name && query.name === contact.name) {
                matches[id] = contact;
            }
        }

        //
        let keys = Object.keys(matches);

        if (query.create && keys.length === 0) {
            // Create a unique ID for this contact
            let id = GLib.uuid_string_random();
            while (this._contacts.hasOwnProperty(id)) {
                id = GLib.uuid_string_random();
            }

            // Add the contact & save to cache
            this._contacts[id] = {
                name: query.name || query.number,
                numbers: [{ number: query.number, type: "unknown" }],
                origin: "gsconnect"
            };
            this._writeCache();

            matches[id] = this._contacts[id];
            keys = Object.keys(matches);
        }

        if (query.single) {
            if (keys.length === 1) {
                return matches[keys[0]];
            }

            return false;
        }

        return matches;
    }

    update() {
        this._updateFolksContacts().then((result) => {
            debug("contacts read from folks");

            this._writeCache();
            [this._provider_icon, this._provider_name] = result;
            this.notify("provider-icon");
            this.notify("provider-name");
            this.notify("contacts");
        }).catch((error) => {
            debug("Warning: Failed to update Folks contacts: " + error.message);

            this._updateGoogleContacts().then((result) => {
                debug("contacts read from google");

                this._writeCache();
                [this._provider_icon, this._provider_name] = result;
                this.notify("provider-icon");
                this.notify("provider-name");
                this.notify("contacts");
            }).catch((error) => {
                debug("Warning: Failed to update Google contacts: " + error.message);
            });
        });
    }

    /**
     * Convenience Methods
     */
    getContact(name, number) {
        debug(arguments);

        return this.query({
            name: name,
            number: number,
            single: true,
            create: true
        });
    }

    // FIXME FIXME FIXME: cleanup, stderr
    _updateFolksContacts() {
        return new Promise((resolve, reject) => {
            let envp = GLib.get_environ();
            envp.push("FOLKS_BACKENDS_DISABLED=telepathy")

            let proc = GLib.spawn_async_with_pipes(
                null,
                ["python3", gsconnect.datadir + "/modules/folks.py"],
                envp,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            let stderr = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: proc[4] })
            });

            stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
                debug("reading stderr...");
                let [result, length] = source.read_line_finish(res);

                if (result === null) {
                    return;
                } else {
                    result = "\n" + result.toString();
                    let line;

                    while ((line = stderr.read_line(null)[0]) !== null) {
                        result = result + "\n" + line.toString();
                    }

                    reject(new Error(result));
                }
            });

            let stdout = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: proc[3] })
            });

            let folks, line;

            while ((line = stdout.read_line(null)[0]) !== null) {
                folks = line.toString();
            }

            try {
                folks = JSON.parse(folks);
                //Object.assign(this._contacts, folks);
                this._contacts = mergeContacts(this._contacts, folks);
                resolve(["gnome-contacts-symbolic", _("Gnome")]);
            } catch (e) {
                reject(e);
            }
        });
    }

    _updateGoogleContacts() {
        return new Promise((resolve, reject) => {
            let contacts = {};
            let goaClient = Goa.Client.new_sync(null);
            let goaAccounts = goaClient.get_accounts();

            for (let id in goaAccounts) {
                let account = goaAccounts[id].get_account();

                if (account.provider_type === "google") {
                    let accountObj = goaClient.lookup_by_id(account.id);
                    let accountAuth = new GData.GoaAuthorizer({
                        goa_object: accountObj
                    });
                    let accountContacts = new GData.ContactsService({
                        authorizer: accountAuth
                    });
                    mergeContacts(
                        contacts,
                        this._getGoogleContacts(accountContacts)
                    );
                }
            }

            this._contacts = mergeContacts(this._contacts, contacts);

            resolve(["goa-account-google", _("Google")]);
        });
    }

    /** Query a Google account for contacts via GData */
    _getGoogleContacts(account) {
        let query = new GData.ContactsQuery({ q: "" });
        let count = 0;
        let contacts = {};

        while (true) {
            let feed = account.query_contacts(
                query, // query,
                null, // cancellable
                (contact) => {
                    let phoneNumbers = contact.get_phone_numbers();

                    // Skip contacts without phone numbers
                    if (!phoneNumbers.length) { return; }

                    let numbers = phoneNumbers.map(n => {
                        return {
                            number: n.number,
                            uri: n.uri || null,
                            type: n.relation_type || "unknown"
                        };
                    });

                    contacts[contact.id] = {
                        name: contact.title || contact.name,
                        numbers: numbers,
                        origin: "google"
                    };
                }
            );

            count += feed.get_entries().length;
            query.start_index = count;

            if (count >= feed.total_results) { break; }
        }

        return contacts
    }

    _writeCache() {
        try {
            this._cacheFile.replace_contents(
                JSON.stringify(this._contacts),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            debug(e);
        }
    }

    destroy() {
        this.emit("destroy");

        this._writeCache();
    }
});


/**
 * Contact Avatar
 */
var Avatar = GObject.registerClass({
    GTypeName: "GSConnectContactAvatar"
}, class Avatar extends Gtk.DrawingArea {

    _init(contact, size=32) {
        super._init({
            height_request: size,
            width_request: size,
            vexpand: false,
            hexpand: false,
            visible: true
        });

        this.contact = contact;
        this.contact.rgb = this.contact.rgb || Color.randomRGB();
        this.size = size;
        this.center = size/2;

        // Image
        if (this.contact.avatar) {
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
        // Default with color
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

        // Popover
        // TODO: use 'popup' signal
        this.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK);
        this.connect("button-release-event", (widget, event) => this._popover(widget, event));

        // Image
        this.connect("draw", this._onDraw.bind(this));
        this.queue_draw();
    }

    // Image
    _onDraw(widget, cr) {
        let offset = 0;

        if (this.contact.avatar) {
            cr.setSourceSurface(this.surface, offset, offset);
            cr.arc(this.size/2, this.size/2, this.size/2, 0, 2*Math.PI);
            cr.clip();
            cr.paint();
        } else {
            offset = (this.size - this.size/1.5) / 2;

            // Colored circle
            cr.setSourceRGB(...this.contact.rgb);
            cr.arc(this.size/2, this.size/2, this.size/2, 0, 2*Math.PI);
            cr.fill();

            // Avatar matched for color
            cr.setSourceRGB(...Color.getFgRGB(this.contact.rgb));
            cr.maskSurface(this.surface, offset, offset);
            cr.fill();
        }

        cr.$dispose();
        return false;
    }

    // Popover
    _popover(widget, event) {
        let popover = new Gtk.PopoverMenu({
            relative_to: this,
            visible: true
        });

        let box = new Gtk.Box({
            margin: 10,
            visible: true
        });
        box.get_style_context().add_class("linked");
        popover.add(box);

        // Gnome Contacts
        if (gsconnect.checkCommand("gnome-contacts") && this.contact.folks_id) {
            let contactsItem = new Gtk.ModelButton({
                centered: true,
                icon: new Gio.ThemedIcon({ name: "gnome-contacts-symbolic" }),
                iconic: true,
                visible: true
            });
            contactsItem.connect("clicked", () => this._popoverContacts());
            box.add(contactsItem);
        }

        // Contact Color
        let colorItem = new Gtk.ModelButton({
            centered: true,
            icon: new Gio.ThemedIcon({ name: "color-select-symbolic" }),
            iconic: true,
            visible: true
        });
        colorItem.connect("clicked", () => this._popoverColor());
        box.add(colorItem);

        // Delete Contact
        if (this.contact.origin === "gsconnect") {
            let deleteItem = new Gtk.ModelButton({
                centered: true,
                icon: new Gio.ThemedIcon({ name: "user-trash-symbolic" }),
                iconic: true,
                visible: true
            });
            deleteItem.connect("clicked", () => this._popoverDelete());
            box.add(deleteItem);
        }

        popover.popup();
    }

    _popoverContacts() {
        GLib.spawn_command_line_async(
            "gnome-contacts -i " + this.contact.folks_id
        );
    }

    _popoverColor(event) {
        let colorChooser = new Gtk.ColorChooserDialog({
            modal: true,
            transient_for: this.get_toplevel(),
            use_alpha: false
        });

        // Set the current color
        let rgba = colorChooser.get_rgba().copy();
        rgba.parse("rgb(" + this.contact.rgb.map(c => c*255).join(",") + ")");
        colorChooser.set_rgba(rgba)

        colorChooser.connect("delete-event", () => {
            this.emit("response", Gtk.ResponseType.CANCEL);
        });
        colorChooser.connect("response", (dialog, response) => {
            if (response !== Gtk.ResponseType.CANCEL) {
                let rgba = dialog.get_rgba();
                this.contact.rgb = [rgba.red, rgba.green, rgba.blue];
                this.queue_draw();
            }

            dialog.destroy();
        });

        colorChooser.show();
    }

    _popoverDelete() {
        let store = getStore();
        let contacts = store._contacts;

        for (let id in contacts) {
            if (contacts[id] === this.contact) {
                delete contacts[id];
                break;
            }
        }

        store._writeCache();
        store.notify("contacts");
    }
});


var ContactChooser = GObject.registerClass({
    GTypeName: "GSConnectContactChooser",
    Properties: {
        "selected": GObject.param_spec_variant(
            "selected",
            "selectedContacts",
            "A list of selected contacts",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        "number-selected": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING ]
        }
    }
}, class ContactChooser extends Gtk.ScrolledWindow {

    _init(params) {
        super._init({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });

        this.contacts = getStore();
        this.contacts.connect("notify::contacts", () => this._populate());

        // Search Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: this.contacts.provider_icon,
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            visible: true
        });
        this.entry.connect("changed", (entry) => this._onEntryChanged());
        this.contacts.bind_property(
            "provider-icon",
            this.entry,
            "primary-icon-name",
            GObject.BindingFlags.SYNC_CREATE
        );

        // ListBox
        this.list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            visible: true
        });
        this.list.set_filter_func(this._filter.bind(this));
        this.list.set_sort_func(this._sort);
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
            spacing: 12,
            visible: true
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
            justify: Gtk.Justification.CENTER,
            visible: true
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
    }

    get selected () {
        return this._selected;
    }

    /**
     * Add a new contact row to the list
     */
    _addContact(contact) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            visible: true
        });
        row.contact = contact;

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        row.add(grid);

        grid.attach(new Avatar(contact), 0, 0, 1, 2);

        row._name = new Gtk.Label({
            label: contact.name || _("Unknown Contact"),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        grid.attach(row._name, 1, 0, 1, 1);

        row.numbers = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            visible: true
        });
        grid.attach(row.numbers, 1, 1, 1, 1);

        this.list.add(row);

        for (let number of contact.numbers) {
            this._addContactNumber(row, number);
        }

        return row;
    }

    /**
     * Add a contact number to a row
     */
    _addContactNumber(row, number) {
        let box = new Gtk.Box({ visible: true });
        box.number = number;
        row.numbers.add(box);

        box._number = new Gtk.Label({
            label: number.number || _("Unknown Number"),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        box._number.get_style_context().add_class("dim-label");
        box.add(box._number);

        box._type = new Gtk.Label({
            label: this._localizeType(number.type),
            margin_right: 12,
            use_markup: true,
            visible: true
        });
        box._type.get_style_context().add_class("dim-label");
        box.add(box._type);

        box.recipient = new Gtk.CheckButton({
            active: false,
            margin_right: 12,
            visible: true
        });
        box.recipient.connect("toggled", () => {
            this._toggle(row, box);
        });
        box.add(box.recipient);

        row.show_all();
    }

    _onEntryChanged(entry) {
        if (this.entry.text.replace(/\D/g, "").length > 2) {
            if (this._dynamic) {
                this._dynamic._name.label = _("Send to %s").format(this.entry.text);
                let num = this._dynamic.numbers.get_children()[0];
                num._number.label = this.entry.text;
                num.contact.number = this.entry.text;
            } else {
                this._dynamic = this._addContact({
                    name: _("Unknown Contact"),
                    numbers: [{ type: "unknown", number: this.entry.text }],
                    rgb: [0.8, 0.8, 0.8]
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
    }

    _filter(row) {
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
        } else if (queryNumber.length) {
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
    }

    /**
     * Return a localized string for a phone number type
     *
     * See: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
     *      http://www.ietf.org/rfc/rfc2426.txt
     */
    _localizeType(type) {
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
    }

    _populate() {
        this.list.foreach(child => child.destroy());

        for (let id in this.contacts._contacts) {
            this._addContact(this.contacts._contacts[id]);
        }
    }

    _sort(row1, row2) {
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
    }

    _toggle(row, box) {
        if (box.recipient.active) {
            if (row.dynamic) {
                row._name.label = box.contact.name;
                delete this._dynamic;
            }

            // FIXME: better signals...
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

