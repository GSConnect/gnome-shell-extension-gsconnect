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
            tooltip_text: contact.name || _('Unknown Contact')
        });

        this._path = contact.avatar;
    }

    _loadPixbuf() {
        if (this._path) {
            this._pixbuf = getPixbuf(this._path, 32);
        }

        if (this._pixbuf === undefined) {
            this._fallback = true;

            this.bg_color = Color.randomRGBA(this.tooltip_text);

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
        return Gdk.EVENT_PROPAGATE;
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

        // If the entry contains string with 3 or more tdigits...
        if (entry.text.replace(/\D/g, '').length >= 3) {
            // ...ensure we have a temporary contact for it
            if (this._temporary === undefined) {
                this._temporary = this.add_contact({
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(this.entry.text),
                    numbers: [{ type: 'manual', value: this.entry.text }]
                });
                this._temporary.__manual = true;

            // ...or if we already do, then update it
            } else {
                // Update UI
                this._temporary.name = _('Send to %s').format(this.entry.text);
                this._temporary.numbers[0].number = this.entry.text;
            }

        // ...otherwise remove any temporary contact that's been created
        } else if (this._temporary) {
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
        if (row.__manual) {
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
        if (row1.__manual) {
            return -1;
        } else if (row2.__manual) {
            return 1;
        } else {
            let row1active = row1.numbers.some(number => number.selected);
            let row2active = row1.numbers.some(number => number.selected);

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
        //let row = new ContactChooserRow(contact);

        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            visible: true
        });

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        row.add(grid);

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

        Object.defineProperties(row, {
            name: {
                get: () => name.get_label(),
                set: (value) => name.set_label(value)
            },
            numbers: {
                get: () => numbers.get_children()
            },
            selected: {
                get: () => numbers.get_children().filter(
                    widget => widget.selected
                ).map(
                    widget => widget.number
                )
            }
        });

        contact.numbers.map(number => this._add_contact_number(numbers, number));

        this._list.add(row);
        return row;
    }

    _toggled(checkbutton) {
        let chooser = checkbutton.get_parent();

        while (!(chooser instanceof Gtk.ScrolledWindow)) {
            chooser = chooser.get_parent();
        }

        chooser.notify('selected');
    }

    _add_contact_number(box, number) {
        let grid = new Gtk.Grid({
            column_spacing: 12
        });
        box.add(grid);

        // Number
        let value = new Gtk.Label({
            label: number.value,
            halign: Gtk.Align.START,
            hexpand: true
        });
        value.get_style_context().add_class('dim-label');
        grid.add(value);

        // Type
        let type = new Gtk.Label({ label: localizeNumberType(number.type) });
        type.get_style_context().add_class('dim-label');
        grid.add(type);

        // Selected
        let checkbutton = new Gtk.CheckButton();
        checkbutton.connect('toggled', this._toggled);
        grid.add(checkbutton);

        // Convenience getter/setter
        Object.defineProperties(grid, {
            'number': {
                get: () => value.get_label(),
                set: (num) => value.set_label(num)
            },
            'selected': {
                get: () => checkbutton.get_active(),
                set: (bool) => checkbutton.set_active(bool)
            }
        });

        grid.show_all();
    }

    /**
     * Reset the selected contacts and re-populate the list
     */
    reset() {
        this._list.foreach(row => {
            row.numbers.map(number => {
                number.selected = false;
            });
        });
    }
});

