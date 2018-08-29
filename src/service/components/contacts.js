'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Color = imports.service.components.color;


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


/**
 * Return a localized string for a phone number type
 * See: http://www.ietf.org/rfc/rfc2426.txt
 *
 * @param {string} type - An RFC2426 phone number type
 */
function localizeNumberType(type) {
    if (!type) { return _('Other'); }

    switch (true) {
        case type.includes('fax'):
            // TRANSLATORS: A phone number type
            return _('Fax');

        case type.includes('work'):
            // TRANSLATORS: A phone number type
            return _('Work');

        case type.includes('cell'):
            // TRANSLATORS: A phone number type
            return _('Mobile');

        case type.includes('home'):
            // TRANSLATORS: A phone number type
            return _('Home');

        default:
            // TRANSLATORS: A phone number type
            return _('Other');
    }
}


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

        // Create a new contact
        // TODO: use folks to add contact
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
            this.notify('contacts');

            matches[id] = this._contacts[id];
            keys = Object.keys(matches);
        }

        // Check for a single match
        if (query.single) {
            if (keys.length === 1) {
                return matches[keys[0]];
            }

            return false;
        }

        return matches;
    }

    async remove(query) {
        if (typeof query === 'object') {
            for (let [id, contact] of Object.entries(this._contacts)) {
                if (query === contact) {
                    delete this._contacts[id];
                    break;
                }
            }
        } else {
            delete this._contacts[query];
        }

        this.notify('contacts');
    }

    async update() {
        let result = 'call-start-symbolic';

        try {
            result = await this._updateFolksContacts();
        } catch (e) {
            Gio.Application.get_default().send_error(e, 'folks-error');
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
                gsconnect.extdatadir + '/service/components/folks.py'
            ]);

            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);

                    if (stderr.length > 0) {
                        throw new Error(stderr)
                    }

                    let folks = JSON.parse(stdout);
                    this._contacts = mergeContacts(this._contacts, folks);
                    resolve('gnome-contacts-symbolic');
                } catch (e) {
                    // format python errors
                    e.stack = e.message;
                    e.message = e.stack.split('\n').filter(l => l).pop();
                    reject(e);
                }
            });
        });
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
            visible: true,
            tooltip_text: contact.name
        });

        this.contact = contact;

        // Popover
        this.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK);
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

    vfunc_button_press_event(event) {
        this.vfunc_popup_menu();
        return true;
    }

    vfunc_draw(cr) {
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

    vfunc_popup_menu() {
        let popover = new Gtk.Popover({
            relative_to: this,
            visible: true
        });
        // FIXME popover closes before button callback executes
        //popover.connect('closed', (popover) => popover.destroy());

        let box = new Gtk.Box({
            margin: 10,
            visible: true
        });
        box.get_style_context().add_class('linked');
        popover.add(box);

        // Gnome Contacts
        if (this.contact.folks_id && hasCommand('gnome-contacts')) {
            let contactsItem = new Gtk.ModelButton({
                centered: true,
                icon: new Gio.ThemedIcon({ name: 'gnome-contacts-symbolic' }),
                iconic: true,
                visible: true
            });
            contactsItem.connect('clicked', this._popoverContacts.bind(this));
            box.add(contactsItem);
        }

        // Delete Contact (local only)
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

        if (box.get_children().length > 0) {
            popover.popup();
            return true;
        } else {
            popover.emit('closed');
            return false;
        }
    }

    _popoverContacts(button, event) {
        GLib.spawn_command_line_async(
            `gnome-contacts -i ${this.contact.folks_id}`
        );
    }

    _popoverDelete(button, event) {
        let store = getStore();
        store.remove(this.contact);
    }
});


var ContactChooserRow = GObject.registerClass({
    GTypeName: 'GSConnectContactChooserRow',
    Properties: {
        'selected': GObject.param_spec_variant(
            'selected',
            'Selected Numbers',
            'A list of selected phone numbers',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class ContactChooserRow extends Gtk.ListBoxRow {

    _init(contact) {
        super._init({
            activatable: false,
            selectable: false,
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

        let name = new Gtk.Label({
            label: contact.name || _('Unknown Contact'),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        grid.attach(name, 1, 0, 1, 1);

        let numbers = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_right: 12,
            spacing: 3,
            visible: true
        });
        grid.attach(numbers, 1, 1, 1, 1);

        for (let entry of contact.numbers) {
            this.addNumber(entry);
        }
    }

    get name() {
        return this.get_child().get_child_at(1, 0).label;
    }

    set name(value) {
        this.get_child().get_child_at(1, 0).label = value;
    }

    get numbers() {
        return this.get_child().get_child_at(1, 1).get_children();
    }

    get selected() {
        return this.numbers.filter(
            b => b.checkbutton.active
        ).map(
            b => b.number
        );
    }

    addNumber(entry) {
        let box = new Gtk.Grid({
            column_spacing: 12,
            visible: true
        });
        Object.defineProperty(box, 'number', {
            get: function() {
                return this.get_child_at(0, 0).label;
            },
            set: function(value) {
                this.get_child_at(0, 0).label = value;
            }
        });
        this.get_child().get_child_at(1, 1).add(box);

        let number = new Gtk.Label({
            // TODO: we have no use for unknown numbers
            label: entry.number || _('Unknown Number'),
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        number.get_style_context().add_class('dim-label');
        box.add(number);

        let type = new Gtk.Label({
            label: localizeNumberType(entry.type),
            use_markup: true,
            visible: true
        });
        type.get_style_context().add_class('dim-label');
        box.add(type);

        box.checkbutton = new Gtk.CheckButton({
            visible: true
        });
        box.checkbutton.connect('toggled', () => this._toggled());
        box.add(box.checkbutton);
    }

    _toggled() {
        // Gtk.ListBox <- Gtk.Viewport <- Gtk.ScrolledWindow
        let chooser = this.get_parent().get_parent().get_parent();
        chooser.emit('selected-numbers-changed');
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
        'selected-numbers-changed': {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    }
}, class ContactChooser extends Gtk.ScrolledWindow {

    _init(params) {
        super._init({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN,
            visible: true
        });

        this.contacts = getStore();
        this._contactsNotifyId = this.contacts.connect(
            'notify::contacts',
            this._populate.bind(this)
        );

        this._temporary = undefined;

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
        this._list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            visible: true
        });
        this._list.set_filter_func(this._filter.bind(this));
        this._list.set_sort_func(this._sort.bind(this));
        this.add(this._list);

        // Placeholder
        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            margin: 12,
            spacing: 12,
            visible: true
        });
        this._list.set_placeholder(box);

        let placeholderImage = new Gtk.Image({
            icon_name: 'avatar-default-symbolic',
            pixel_size: 48,
            visible: true
        });
        placeholderImage.get_style_context().add_class('dim-label');
        box.add(placeholderImage);

        let placeholderLabel = new Gtk.Label({
            label: '<b>' + _('Add people to start a conversation') + '</b>',
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            visible: true
        });
        placeholderLabel.get_style_context().add_class('dim-label');
        box.add(placeholderLabel);

        // Populate and setup
        this._populate();
    }

    get selected () {
        if (this._selected === undefined) {
            this._selected = new Map();
        }

        this._list.foreach(row => {
            for (let number of row.selected) {
                this._selected.set(number, row.contact);
            }
        });

        return this._selected;
    }

    _destroy() {
        // Set to null to allow the bound context to be freed
        this._list.set_filter_func(null);
        this._list.set_sort_func(null);

        // Explicitly disconnect & destroy the entry in case it's floating
        this.entry.disconnect(this._entryChangedId);

        if (this.entry.get_parent() === null) {
            this.entry.destroy();
        }

        this.contacts.disconnect(this._contactsNotifyId);
        delete this.contacts;
    }

    // FIXME: one bugly hack job right here
    _onEntryChanged(entry) {
        // If the entry contains string with more than 2 digits...
        if (this.entry.text.replace(/\D/g, '').length > 2) {
            // ...ensure we have a temporary contact for it
            if (this._temporary === undefined) {
                this._temporary = this.add_contact({
                    name: _('Send to %s').format(this.entry.text),
                    numbers: [{ type: 'unknown', number: this.entry.text }]
                });

            // ...or if we already do, then update it
            } else {
                // Update UI
                this._temporary.name = _('Send to %s').format(this.entry.text);
                this._temporary.numbers[0].number = this.entry.text;

                // Update contact object
                this._temporary.contact.number = this.entry.text;
                this._temporary.contact.numbers[0].number = this.entry.text;
            }

        // ...otherwise remove any temporary contact that's been created
        } else if (this._temporary !== undefined) {
            this._temporary.destroy();
            this._temporary = undefined;
        }

        this._list.invalidate_filter();
        this._list.invalidate_sort();
    }

    _filter(row) {
        let queryName = this.entry.text.toLocaleLowerCase();
        let queryNumber = this.entry.text.replace(/\D/g, '');

        // Dynamic contact always shown
        if (row === this._temporary) {
            return true;
        // Show contact and all numbers if text is substring of name
        } else if (row.name.toLocaleLowerCase().includes(queryName)) {
            row.show_all();
            return true;
        // Show contact but hide numbers based on substring of number
        } else if (queryNumber.length) {
            let matched = false

            for (let num of row.numbers) {
                let number = num.number.replace(/\D/g, '');

                if (number.includes(queryNumber)) {
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
        this._list.foreach(row => row.destroy());

        for (let contact of Object.values(this.contacts._contacts)) {
            this.add_contact(contact);
        }
    }

    _sort(row1, row2) {
        if (row1 === this._temporary) {
            return -1;
        } else if (row2 === this._temporary) {
            return 1;
        } else {
            let row1active, row2active;

            for (let num of row1.numbers) {
                if (num.checkbutton.active) {
                    row1active = true;
                    break;
                }
            }

            for (let num of row2.numbers) {
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

        return row1.name.localeCompare(row2.name);
    }

    /**
     * Add a new contact row to the list
     *
     * @param {Object} contact - A contact object
     */
    add_contact(contact) {
        let row = new ContactChooserRow(contact);
        this._list.add(row);
        return row;
    }

    /**
     * Reset the selected contacts and re-populate the list
     */
    reset() {
        this._list.foreach(row => {
            row.numbers.map(number => {
                number.checkbutton.active = false;
            });
        });
        this.selected.clear();
    }
});

