'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Color = imports.service.components.color;


/**
 * Get Gdk.Pixbuf for @path, allowing the corrupt JPEG's KDE Connect sometimes
 * sends. This function is synchronous
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

    // Scale if requested
    if (size !== null) {
        return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
    } else {
        return pixbuf;
    }
}


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

            this.bg_color = Color.randomRGBA(this.contact.name);

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

        this._offset = (this.width_request - this._pixbuf.width) / 2;
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
        popover.add(box);

        // Gnome Contacts
        if (this.contact.origin === 'folks' && hasCommand('gnome-contacts')) {
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
            popover.destroy();
            return false;
        }
    }

    _popoverContacts(button, event) {
        GLib.spawn_command_line_async(
            `gnome-contacts -i ${this.contact.id}`
        );
    }

    _popoverDelete(button, event) {
        let service = Gio.Application.get_default();
        service.contacts.remove(this.contact);
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

    addNumber(number) {
        let grid = new Gtk.Grid({
            column_spacing: 12,
            visible: true
        });
        Object.defineProperty(grid, 'number', {
            get: function() {
                return this.get_child_at(0, 0).label;
            },
            set: function(value) {
                this.get_child_at(0, 0).label = value;
            }
        });
        this.get_child().get_child_at(1, 1).add(grid);

        let value = new Gtk.Label({
            label: number.value,
            halign: Gtk.Align.START,
            hexpand: true,
            visible: true
        });
        value.get_style_context().add_class('dim-label');
        grid.add(value);

        let type = new Gtk.Label({
            label: localizeNumberType(number.type),
            use_markup: true,
            visible: true
        });
        type.get_style_context().add_class('dim-label');
        grid.add(type);

        grid.checkbutton = new Gtk.CheckButton({
            visible: true
        });
        grid.checkbutton.connect('toggled', this._toggled);
        grid.add(grid.checkbutton);
    }

    _toggled(checkbutton) {
        // Gtk.Grid (number) <- Gtk.Box (numbers) <- Gtk.Grid <- Gtk.ListBoxRow
        let row = checkbutton.get_parent().get_parent().get_parent().get_parent();
        // Gtk.ListBox <- Gtk.Viewport <- Gtk.ScrolledWindow
        let chooser = row.get_parent().get_parent().get_parent();
        chooser.notify('selected');
    }
});


var ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'store': GObject.ParamSpec.object(
            'store',
            'Store',
            'The contacts store',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'selected': GObject.param_spec_variant(
            'selected',
            'selectedContacts',
            'A list of selected contacts',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class ContactChooser extends Gtk.ScrolledWindow {

    _init(params) {
        super._init(Object.assign({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN,
            visible: true
        }, params));

        this._contactsNotifyId = this.store.connect(
            'notify::contacts',
            this._populate.bind(this)
        );

        this._temporary = undefined;

        // Search Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('Type a phone number or name'),
            tooltip_text: _('Type a phone number or name'),
            primary_icon_name: this.store.provider_icon,
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
        this._list._entry = this.entry.text;
        this._list.set_filter_func(this._filter);
        this._list.set_sort_func(this._sort);
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
        let selected = new Set();
        this._list.foreach(row => {
            row.selected.map(number => selected.add(number));
        });
        return Array.from(selected);
    }

    _destroy() {
        // Explicitly disconnect & destroy the entry in case it's floating
        this.entry.disconnect(this._entryChangedId);

        if (this.entry.get_parent() === null) {
            this.entry.destroy();
        }

        this.store.disconnect(this._contactsNotifyId);
    }

    // FIXME: one bugly hack job right here
    _onEntryChanged(entry) {
        this._list._entry = entry.text;

        // If the entry contains string with more than 2 digits...
        if (entry.text.replace(/\D/g, '').length > 2) {
            // ...ensure we have a temporary contact for it
            if (this._temporary === undefined) {
                this._temporary = this.add_contact({
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(this.entry.text),
                    numbers: [{ type: 'manual', number: this.entry.text }]
                });

            // ...or if we already do, then update it
            } else {
                // Update UI
                this._temporary.name = _('Send to %s').format(this.entry.text);
                this._temporary.numbers[0].number = this.entry.text;

                // Update contact object
                this._temporary.contact.numbers[0].value = this.entry.text;
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
        let list = row.get_parent();
        let queryName = list._entry.toLocaleLowerCase();
        let queryNumber = list._entry.replace(/\D/g, '');

        // Dynamic contact always shown
        if (row.contact.numbers[0].type === 'manual') {
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

        for (let contact of this.store) {
            this.add_contact(contact);
        }
    }

    _sort(row1, row2) {
        if (row1.contact.numbers[0].type === 'manual') {
            return -1;
        } else if (row2.contact.numbers[0].type === 'manual') {
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
    }
});

