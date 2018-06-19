'use strict';

const Gettext = imports.gettext.domain('org.gnome.Shell.Extensions.GSConnect');
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


// TODO: folks, prefs check Contacts.GData, etc
try {
    imports.gi.versions.GData = '0.0';
    imports.gi.versions.Goa = '1.0';

    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    logWarning(e);
    var GData = undefined;
    var Goa = undefined;
}

const Color = imports.modules.color;


//
var CACHE_DIR = GLib.build_filenamev([gsconnect.cachedir, '_contacts']);


// Return a singleton
var _contactsStore;

function getStore() {
    if (_contactsStore === undefined) {
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
function getPixbuf(path, size=null) {
    let data, loader;

    // Catch missing avatar files
    try {
        data = GLib.file_get_contents(path)[1];
    } catch (e) {
        logWarning(e.message, path);
        return undefined;
    }

    // Consider errors from partially corrupt JPEGs to be warnings
    try {
        loader = new GdkPixbuf.PixbufLoader();
        loader.write(data);
        loader.close();
    } catch (e) {
        logWarning(e, path);
    }

    let pixbuf = loader.get_pixbuf();

    if (size !== null) {
        return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
    }

    return pixbuf;
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
//            ['name', 'origin', 'avatar', 'folk_id'].forEach(prop => {
//                current[id][prop] = update[id][prop] || current[id][prop];
//            });

//            for (let entry of updateContact.numbers) {
//                let found = false;

//                for (let centry of current[id].numbers) {
//                    if (entry.number === centry.number) {
//                        ['type', 'uri'].forEach(prop => {
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
    GTypeName: 'GSConnectContactsStore',
    Properties: {
        'contacts': GObject.param_spec_variant(
            'contacts',
            'ContactsList',
            'A list of cached contacts',
            new GLib.VariantType('as'),
            new GLib.Variant('as', []),
            GObject.ParamFlags.READABLE
        ),
        'provider-icon': GObject.ParamSpec.string(
            'provider-icon',
            'ContactsProvider',
            'The contact provider icon name',
            GObject.ParamFlags.READABLE,
            ''
        )
    },
    Signals: {
        'destroy': { flags: GObject.SignalFlags.NO_HOOKS },
        'ready': { flags: GObject.SignalFlags.RUN_FIRST }
    }
}, class Store extends GObject.Object {

    _init() {
        super._init();

        // Init cache
        GLib.mkdir_with_parents(CACHE_DIR, 448);

        this._cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([CACHE_DIR, 'contacts.json'])
        );

        // Read cache
        this._cacheFile.load_contents_async(null, (file, res) => {
            try {
                let contents = file.load_contents_finish(res)[1];
                this._contacts = JSON.parse(contents);
            } catch (e) {
                this._contacts = {};
            } finally {
                this.connect('notify::contacts', this._writeCache.bind(this));
                this.update();
            }
        });
    }

    get contacts() {
        return Object.keys(this._contacts);
    }

    get provider_icon() {
        if (this._provider_icon === undefined) {
            return 'call-start-symbolic';
        }

        return this._provider_icon;
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {Object} query - A query object
     * @param {String} [query.name] - The contact's name
     * @param {String} [query.number] - The contact's number
     * @param {Boolean} [query.single] - Only return if there is a single match
     * @param {Boolean} [query.create] - Create and return a new contact if none
     */
    query(query) {
        let number = (query.number) ? query.number.replace(/\D/g, '') : null;

        let matches = {};

        for (let id in this._contacts) {
            let contact = this._contacts[id];

            // Prioritize searching by number
            if (number) {
                for (let num of contact.numbers) {
                    // Match by number stripped of non-digits
                    if (number === num.number.replace(/\D/g, '')) {
                        matches[id] = contact;

                        // Number match & exact name match; must be it
                        if (query.name && query.name === contact.name) {
                            return contact;
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

        if (keys.length === 0 && query.create) {
            // Create a unique ID for this contact
            let id = GLib.uuid_string_random();
            while (this._contacts.hasOwnProperty(id)) {
                id = GLib.uuid_string_random();
            }

            // Add the contact & save to cache
            this._contacts[id] = {
                name: query.name || query.number,
                numbers: [{ number: query.number, type: 'unknown' }],
                origin: 'gsconnect'
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

    async update() {
        let result = 'call-start-symbolic';

        try {
            result = await this._updateFolksContacts();
        } catch (e) {
            logWarning(e, 'Reading contacts from Folks');

            try {
                result = await this._updateGoogleContacts();
            } catch (e) {
                logWarning(e, 'Reading contacts from Google');
            }
        } finally {
            this._provider_icon = result;
            this.notify('provider-icon');
            this.notify('contacts');
        }
    }

    _updateFolksContacts() {
        return new Promise((resolve, reject) => {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });

            launcher.setenv('FOLKS_BACKENDS_DISABLED', 'telepathy', true);

            let proc = launcher.spawnv([
                'python3',
                gsconnect.datadir + '/modules/folks.py'
            ]);

            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                    proc.force_exit();
                    proc.wait(null);

                    if (stderr.length > 0) {
                        throw new Error(stderr)
                    }

                    let folks = JSON.parse(stdout);
                    this._contacts = mergeContacts(this._contacts, folks);
                    resolve('gnome-contacts-symbolic');
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _updateGoogleContacts() {
        return new Promise((resolve, reject) => {
            let contacts = {};
            let goaClient = Goa.Client.new_sync(null);
            let goaAccounts = goaClient.get_accounts();

            for (let id in goaAccounts) {
                let account = goaAccounts[id].get_account();

                if (account.provider_type === 'google') {
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

            resolve('goa-account-google');
        });
    }

    /** Query a Google account for contacts via GData */
    _getGoogleContacts(account) {
        let query = new GData.ContactsQuery({ q: '' });
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
                            type: n.relation_type || 'unknown'
                        };
                    });

                    contacts[contact.id] = {
                        name: contact.title || contact.name,
                        numbers: numbers,
                        origin: 'google'
                    };
                }
            );

            count += feed.get_entries().length;
            query.start_index = count;

            if (count >= feed.total_results) { break; }
        }

        return contacts;
    }

    _writeCache() {
        this._cacheFile.replace_contents_async(
            JSON.stringify(this._contacts),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );
    }

    destroy() {
        // Write synchronously on destroy
        try {
            this._cacheFile.replace_contents(
                JSON.stringify(this._contacts),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logError(e);
        }

        this.emit('destroy');
    }
});


/**
 * Contact Avatar
 */
var Avatar = GObject.registerClass({
    GTypeName: 'GSConnectContactAvatar'
}, class Avatar extends Gtk.DrawingArea {

    _init(contact) {
        super._init({
            height_request: 32,
            width_request: 32,
            vexpand: false,
            hexpand: false,
            visible: true,
            tooltip_text: contact.name
        });

        this.contact = contact;

        // Popover
        // TODO: use 'popup' signal
        this.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK);
        this.connect('button-release-event', this._popover.bind(this));

        // Image
        this.connect('draw', this._onDraw.bind(this));
    }

    _loadPixbuf() {
        if (this.contact.avatar) {
            this._pixbuf = getPixbuf(this.contact.avatar, 32);
        }

        if (this._pixbuf === undefined) {
            this._fallback = true;

            if (this.contact.name === _('Unknown Contact')) {
                this.bg_color = new Gdk.RGBA({ red: 0.8, green: 0.8, blue: 0.8, alpha: 1 });
            } else {
                this.bg_color = Color.randomRGBA(this.contact.name);
            }

            let info = Gtk.IconTheme.get_default().lookup_icon(
               'avatar-default',
               24,
               Gtk.IconLookupFlags.FORCE_SYMBOLIC
            );

            this._pixbuf = info.load_symbolic(
                Color.getFgRGBA(this.bg_color),
                null,
                null,
                null
            )[0];
        }

        this._offset = (32 - this._pixbuf.width) / 2;
    }

    _onDraw(widget, cr) {
        if (this._pixbuf === undefined) {
            this._loadPixbuf();
        }

        // Clip to a circle
        cr.arc(16, 16, 16, 0, 2*Math.PI);
        cr.clipPreserve();

        // Fill the background if we don't have an avatar
        if (this._fallback) {
            Gdk.cairo_set_source_rgba(cr, this.bg_color);
            cr.fill();
        }

        // Draw the avatar/icon
        Gdk.cairo_set_source_pixbuf(cr, this._pixbuf, this._offset, this._offset);
        cr.paint();

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
        box.get_style_context().add_class('linked');
        popover.add(box);

        // Gnome Contacts
        if (gsconnect.hasCommand('gnome-contacts') && this.contact.folks_id) {
            let contactsItem = new Gtk.ModelButton({
                centered: true,
                icon: new Gio.ThemedIcon({ name: 'gnome-contacts-symbolic' }),
                iconic: true,
                visible: true
            });
            contactsItem.connect('clicked', this._popoverContacts.bind(this));
            box.add(contactsItem);
        }

        // Delete Contact
        if (this.contact.origin === 'gsconnect') {
            let deleteItem = new Gtk.ModelButton({
                centered: true,
                icon: new Gio.ThemedIcon({ name: 'user-trash-symbolic' }),
                iconic: true,
                visible: true
            });
            deleteItem.connect('clicked', this._popoverDelete.bind(this));
            box.add(deleteItem);
        }

        popover.popup();
    }

    _popoverContacts(button, event) {
        GLib.spawn_command_line_async(
            `gnome-contacts -i ${this.contact.folks_id}`
        );
    }

    _popoverDelete(button, event) {
        let store = getStore();
        let contacts = store._contacts;

        for (let id in contacts) {
            if (contacts[id] === this.contact) {
                delete contacts[id];
                break;
            }
        }

        store.notify('contacts');
    }
});


var ContactChooserRow = GObject.registerClass({
    GTypeName: 'GSConnectContactChooserRow',
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class ContactChooserRow extends Gtk.ListBoxRow {

    _init(contact) {
        super._init({
            activatable: false,
            visible: true
        });

        this.contact = contact;

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        this.add(grid);

        grid.attach(new Avatar(contact), 0, 0, 1, 2);

        this._name = new Gtk.Label({
            label: contact.name || _('Unknown Contact'),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        grid.attach(this._name, 1, 0, 1, 1);

        this.numbers = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            visible: true
        });
        grid.attach(this.numbers, 1, 1, 1, 1);

        for (let entry of contact.numbers) {
            this.addNumber(entry);
        }
    }

    get name() {
        return this._name.label;
    }

    set name(value) {
        this._name.label = value;
    }

    addNumber(entry) {
        let box = new Gtk.Box({ visible: true });
        box.number = entry;
        this.numbers.add(box);

        box._number = new Gtk.Label({
            label: entry.number || _('Unknown Number'),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        box._number.get_style_context().add_class('dim-label');
        box.add(box._number);

        box._type = new Gtk.Label({
            label: this._localizeType(entry.type),
            margin_right: 12,
            use_markup: true,
            visible: true
        });
        box._type.get_style_context().add_class('dim-label');
        box.add(box._type);

        box.checkbutton = new Gtk.CheckButton({
            active: false,
            margin_right: 12,
            visible: true
        });
        box.checkbutton.connect('toggled', (checkbutton) => {
            this.emit('number-selected', checkbutton.get_parent());
        });
        box.add(box.checkbutton);

        this.show_all();
    }

    /**
     * Return a localized string for a phone number type
     * See: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
     *      http://www.ietf.org/rfc/rfc2426.txt
     */
    _localizeType(type) {
        if (!type) { return _('Other'); }

        if (type.indexOf('fax') > -1) {
            // TRANSLATORS: A phone number type
            return _('Fax');
        // Sometimes libfolks->voice === GData->work
        } else if (type.indexOf('work') > -1 || type.indexOf('voice') > -1) {
            // TRANSLATORS: A phone number type
            return _('Work');
        } else if (type.indexOf('cell') > -1 || type.indexOf('mobile') > -1) {
            // TRANSLATORS: A phone number type
            return _('Mobile');
        } else if (type.indexOf('home') > -1 ) {
            // TRANSLATORS: A phone number type
            return _('Home');
        } else {
            // TRANSLATORS: A phone number type
            return _('Other');
        }
    }
});


var ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'selected': GObject.param_spec_variant(
            'selected',
            'selectedContacts',
            'A list of selected contacts',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        'number-selected': {
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
        this._contactsNotifyId = this.contacts.connect(
            'notify::contacts',
            this._populate.bind(this)
        );

        // Search Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('Type a phone number or name'),
            tooltip_text: _('Type a phone number or name'),
            primary_icon_name: this.contacts.provider_icon,
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            visible: true
        });
        this._entryChangedId = this.entry.connect(
            'changed',
            this._onEntryChanged.bind(this)
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
            icon_name: 'avatar-default-symbolic',
            pixel_size: 48,
            visible: true
        });
        placeholderImage.get_style_context().add_class('dim-label');
        box.add(placeholderImage);

        let placeholderLabel = new Gtk.Label({
            label: '<b>' + _('Add people to start a conversation') + '</b>',
            visible: true,
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            visible: true
        });
        placeholderLabel.get_style_context().add_class('dim-label');

        box.add(placeholderLabel);
        this.list.set_placeholder(box);

        this.connect('destroy', this._onDestroy.bind(this));

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
     * Reset the selected contacts and re-populate the list
     */
    reset() {
        this.selected.clear();
        this._populate();
    }

    /**
     * Add a new contact row to the list
     */
    _addContact(contact) {
        let row = new ContactChooserRow(contact);
        row.connect('number-selected', this._toggle.bind(this));
        this.list.add(row);
        return row;
    }

    _onDestroy() {
        this.disconnect(this._entryChangedId);
        this.entry.destroy();

        this.contacts.disconnect(this._contactsNotifyId);
        delete this.contacts;
    }

    _onEntryChanged(entry) {
        if (this.entry.text.replace(/\D/g, '').length > 2) {
            if (this._temporary) {
                this._temporary._name.label = _('Send to %s').format(this.entry.text);
                let num = this._temporary.numbers.get_children()[0];
                num._number.label = this.entry.text;
                this._temporary.contact.number = this.entry.text;
                this._temporary.contact.numbers[0].number = this.entry.text;
            } else {
                this._temporary = this._addContact({
                    name: _('Unknown Contact'),
                    numbers: [{ type: 'unknown', number: this.entry.text }]
                });
                this._temporary._name.label = _('Send to %s').format(this.entry.text);
                this._temporary.dynamic = true;
            }
        } else if (this._temporary) {
            this._temporary.destroy();
            delete this._temporary;
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    _filter(row) {
        let queryName = this.entry.text.toLowerCase();
        let queryNumber = this.entry.text.replace(/\D/g, '');

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
                let number = num._number.label.replace(/\D/g, '');
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
                if (num.checkbutton.active) {
                    row1active = true;
                    break;
                }
            }

            for (let num of row2.numbers.get_children()) {
                if (num.checkbutton.active) {
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
        if (box.checkbutton.active) {
            if (row.dynamic) {
                row._name.label = row.contact.name;
                delete this._temporary;
            }

            // FIXME: better signals...
            this._selected.set(box.number.number, row.contact);
            this.notify('selected');
            this.emit('number-selected', box.number.number);
        } else {
            this._selected.delete(box.number.number);
            this.notify('selected');
        }

        this.entry.text = '';
        this.list.invalidate_sort();
    }
});

