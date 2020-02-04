'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/**
 * Return a random color
 *
 * @param {*} [salt] - If not %null, will be used as salt for generating a color
 * @param {Number} alpha - A value in the [0...1] range for the alpha channel
 * @return {Gdk.RGBA} - A new Gdk.RGBA object generated from the input
 */
function randomRGBA(salt = null, alpha = 1.0) {
    let red, green, blue;

    if (salt !== null) {
        let hash = new GLib.Variant('s', `${salt}`).hash();
        red = ((hash & 0xFF0000) >> 16) / 255;
        green = ((hash & 0x00FF00) >> 8) / 255;
        blue = (hash & 0x0000FF) / 255;
    } else {
        red = Math.random();
        green = Math.random();
        blue = Math.random();
    }

    return new Gdk.RGBA({red: red, green: green, blue: blue, alpha: alpha});
}


/**
 * Get the relative luminance of a RGB set
 * See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
 *
 * @param {Number} r - A number in the [0.0, 1.0] range for the red value
 * @param {Number} g - A number in the [0.0, 1.0] range for the green value
 * @param {Number} b - A number in the [0.0, 1.0] range for the blue value
 * @return {Number} - ...
 */
function relativeLuminance(rgba) {
    let {red, green, blue} = rgba;

    let R = (red > 0.03928) ? red / 12.92 : Math.pow(((red + 0.055) / 1.055), 2.4);
    let G = (green > 0.03928) ? green / 12.92 : Math.pow(((green + 0.055) / 1.055), 2.4);
    let B = (blue > 0.03928) ? blue / 12.92 : Math.pow(((blue + 0.055) / 1.055), 2.4);

    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}


/**
 * Get a Gdk.RGBA contrasted for the input
 * See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 *
 * @param {Gdk.RGBA} - A Gdk.RGBA object for the background color
 * @return {Gdk.RGBA} - A Gdk.RGBA object for the foreground color
 */
function getFgRGBA(rgba) {
    let bgLuminance = relativeLuminance(rgba);
    let lightContrast = (0.07275541795665634 + 0.05) / (bgLuminance + 0.05);
    let darkContrast = (bgLuminance + 0.05) / (0.0046439628482972135 + 0.05);

    let value = (darkContrast > lightContrast) ? 0.06 : 0.94;
    return new Gdk.RGBA({red: value, green: value, blue: value, alpha: 0.5});
}


/**
 * Get Gdk.Pixbuf for @path, allowing the corrupt JPEG's KDE Connect sometimes
 * sends. This function is synchronous.
 *
 * @param {string} path - A local file path
 */
function getPixbufForPath(path, size = null, scale) {
    let data, loader, pixbuf;

    // Catch missing avatar files
    try {
        data = GLib.file_get_contents(path)[1];
    } catch (e) {
        debug(e, path);
        return undefined;
    }

    // Consider errors from partially corrupt JPEGs to be warnings
    try {
        loader = new GdkPixbuf.PixbufLoader();
        loader.write(data);
        loader.close();
    } catch (e) {
        debug(e, path);
    }

    pixbuf = loader.get_pixbuf();

    // Scale to monitor
    size = size * scale;
    return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
}

function getPixbufForIcon(name, size, scale, bgColor) {
    let color = getFgRGBA(bgColor);
    let theme = Gtk.IconTheme.get_default();
    let info = theme.lookup_icon_for_scale(
        name,
        size,
        scale,
        Gtk.IconLookupFlags.FORCE_SYMBOLIC
    );

    return info.load_symbolic(color, null, null, null)[0];
}


/**
 * Return a localized string for a phone number and type
 * See: http://www.ietf.org/rfc/rfc2426.txt
 *
 * @param {string} number - A phone number and RFC2426 phone number type
 * @return {string} - A string like '555-5555・Mobile'
 */
function getNumberLabel(number) {
    if (!number.type) return _('%s・Other').format(number.value);

    switch (true) {
        case number.type.includes('fax'):
            // TRANSLATORS: A fax number
            return _('%s・Fax').format(number.value);

        case number.type.includes('work'):
            // TRANSLATORS: A work phone number
            return _('%s・Work'.format(number.value));

        case number.type.includes('cell'):
            // TRANSLATORS: A mobile or cellular phone number
            return _('%s・Mobile').format(number.value);

        case number.type.includes('home'):
            // TRANSLATORS: A home phone number
            return _('%s・Home').format(number.value);

        default:
            // TRANSLATORS: All other phone number types
            return _('%s・Other').format(number.value);
    }
}

/**
 * Get a display number from @contact for @address.
 *
 * @param {object} contact - A contact object
 * @param {string} address - A phone number
 */
function getDisplayNumber(contact, address) {
    let number = address.toPhoneNumber();

    for (let contactNumber of contact.numbers) {
        let cnumber = contactNumber.value.toPhoneNumber();

        if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
            return GLib.markup_escape_text(contactNumber.value, -1);
        }
    }

    return GLib.markup_escape_text(address, -1);
}


/**
 * Contact Avatar
 */
const AvatarCache = new WeakMap();

var Avatar = GObject.registerClass({
    GTypeName: 'GSConnectContactAvatar'
}, class Avatar extends Gtk.DrawingArea {

    _init(contact = null) {
        super._init({
            height_request: 32,
            width_request: 32,
            valign: Gtk.Align.CENTER,
            visible: true
        });

        this.contact = contact;
    }

    get rgba() {
        if (this._rgba === undefined) {
            if (this.contact) {
                this._rgba = randomRGBA(this.contact.name);
            } else {
                this._rgba = randomRGBA(GLib.uuid_string_random());
            }
        }

        return this._rgba;
    }

    get contact() {
        if (this._contact === undefined) {
            this._contact = null;
        }

        return this._contact;
    }

    set contact(contact) {
        if (this.contact !== contact) {
            this._contact = contact;

            this._surface = undefined;
            this._rgba = undefined;
            this._offset = 0;
        }
    }

    _loadSurface() {
        // Get the monitor scale
        let display = Gdk.Display.get_default();
        let monitor = display.get_monitor_at_window(this.get_window());
        let scale = monitor.get_scale_factor();

        // If there's a contact with an avatar, try to load it
        if (this.contact && this.contact.avatar) {
            // Check the cache
            this._surface = AvatarCache.get(this.contact);

            // Try loading the pixbuf
            if (!this._surface) {
                let pixbuf = getPixbufForPath(
                    this.contact.avatar,
                    this.width_request,
                    scale
                );

                if (pixbuf) {
                    this._surface = Gdk.cairo_surface_create_from_pixbuf(
                        pixbuf,
                        0,
                        this.get_window()
                    );
                    AvatarCache.set(this.contact, this._surface);
                }
            }
        }

        // If we still don't have a surface, load a fallback
        if (!this._surface) {
            let iconName;

            // If we were given a contact, it's direct message
            if (this.contact) {
                iconName = 'avatar-default-symbolic';
            // Otherwise it's a group message
            } else {
                iconName = 'group-avatar-symbolic';
            }

            this._offset = (this.width_request - 24) / 2;

            // Load the fallback
            let pixbuf = getPixbufForIcon(iconName, 24, scale, this.rgba);

            this._surface = Gdk.cairo_surface_create_from_pixbuf(
                pixbuf,
                0,
                this.get_window()
            );
        }
    }

    vfunc_draw(cr) {
        if (!this._surface) {
            this._loadSurface();
        }

        // Clip to a circle
        let rad = this.width_request / 2;
        cr.arc(rad, rad, rad, 0, 2 * Math.PI);
        cr.clipPreserve();

        // Fill the background if the the surface is offset
        if (this._offset > 0) {
            Gdk.cairo_set_source_rgba(cr, this.rgba);
            cr.fill();
        }

        // Draw the avatar/icon
        cr.setSourceSurface(this._surface, this._offset, this._offset);
        cr.paint();

        cr.$dispose();
        return Gdk.EVENT_PROPAGATE;
    }
});


var ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'store': GObject.ParamSpec.object(
            'store',
            'Store',
            'The contacts store',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            GObject.Object
        )
    },
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        }
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contact-chooser.ui',
    Children: ['entry', 'list', 'scrolled']
}, class ContactChooser extends Gtk.Grid {

    _init(params) {
        super._init(params);

        // Setup the contact list
        this.list._entry = this.entry.text;
        this.list.set_filter_func(this._filter);
        this.list.set_sort_func(this._sort);

        // Make sure we're using the correct contacts store
        this.device.bind_property(
            'contacts',
            this,
            'store',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    get store() {
        if (this._store === undefined) {
            this._store = null;
        }

        return this._store;
    }

    set store(store) {
        // Do nothing if the store hasn't changed
        if (this.store === store) return;

        // Unbind the old store
        if (this._store) {
            // Disconnect from the store
            this._store.disconnect(this._contactAddedId);
            this._store.disconnect(this._contactRemovedId);
            this._store.disconnect(this._contactChangedId);

            // Clear the contact list
            let rows = this.list.get_children();

            for (let i = 0, len = rows.length; i < len; i++) {
                rows[i].destroy();
                // HACK: temporary mitigator for mysterious GtkListBox leak
                imports.system.gc();
            }
        }

        // Set the store
        this._store = store;

        // Bind the new store
        if (this._store) {
            // Connect to the new store
            this._contactAddedId = store.connect(
                'contact-added',
                this._onContactAdded.bind(this)
            );

            this._contactRemovedId = store.connect(
                'contact-removed',
                this._onContactRemoved.bind(this)
            );

            this._contactChangedId = store.connect(
                'contact-changed',
                this._onContactChanged.bind(this)
            );

            // Populate the list
            this._populate();
        }
    }

    /**
     * ContactStore Callbacks
     */
    _onContactAdded(store, id) {
        let contact = this.store.get_contact(id);
        this._addContact(contact);
    }

    _onContactRemoved(store, id) {
        let rows = this.list.get_children();

        for (let i = 0, len = rows.length; i < len; i++) {
            let row = rows[i];

            if (row.contact.id === id) {
                row.destroy();
                // HACK: temporary mitigator for mysterious GtkListBox leak
                imports.system.gc();
            }
        }
    }

    _onContactChanged(store, id) {
        this._onContactRemoved(store, id);
        this._onContactAdded(store, id);
    }

    _onDestroy(chooser) {
        chooser.store = null;
    }

    _onSearchChanged(entry) {
        this.list._entry = entry.text;
        let dynamic = this.list.get_row_at_index(0);

        // If the entry contains string with 2 or more digits...
        if (entry.text.replace(/\D/g, '').length >= 2) {
            // ...ensure we have a dynamic contact for it
            if (!dynamic || !dynamic.__tmp) {
                dynamic = this._addContact({
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(entry.text),
                    numbers: [{type: 'unknown', value: entry.text}]
                });
                dynamic.__tmp = true;

            // ...or if we already do, then update it
            } else {
                // Update contact object
                dynamic.contact.name = entry.text;
                dynamic.contact.numbers[0].value = entry.text;

                // Update UI
                let grid = dynamic.get_child();
                let nameLabel = grid.get_child_at(1, 0);
                nameLabel.label = _('Send to %s').format(entry.text);
                let numLabel = grid.get_child_at(1, 1);
                numLabel.label = getNumberLabel(dynamic.contact.numbers[0]);
            }

        // ...otherwise remove any dynamic contact that's been created
        } else if (dynamic && dynamic.__tmp) {
            dynamic.destroy();
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    // GtkListBox::row-selected
    _onNumberSelected(box, row) {
        if (row === null) return;

        // Emit the number
        let address = row.number.value;
        this.emit('number-selected', address);

        // Reset the contact list
        this.entry.text = '';
        this.list.select_row(null);
        this.scrolled.vadjustment.value = 0;
    }

    _filter(row) {
        // Dynamic contact always shown
        if (row.__tmp) return true;

        let query = row.get_parent()._entry;
        let queryName = query.toLocaleLowerCase();
        let queryNumber = query.toPhoneNumber();

        // Show contact if text is substring of name
        if (row.contact.name.toLocaleLowerCase().includes(queryName)) {
            return true;

        // Show contact if text is substring of number
        } else if (queryNumber.length) {
            for (let number of row.contact.numbers) {
                if (number.value.toPhoneNumber().includes(queryNumber)) {
                    return true;
                }
            }

        // Query is effectively empty
        } else if (/^0+/.test(query)) {
            return true;
        }

        return false;
    }

    _sort(row1, row2) {
        if (row1.__tmp) {
            return -1;
        } else if (row2.__tmp) {
            return 1;
        }

        return row1.contact.name.localeCompare(row2.contact.name);
    }

    _populate() {
        // Add each contact
        let contacts = this.store.contacts;

        for (let i = 0, len = contacts.length; i < len; i++) {
            this._addContact(contacts[i]);
        }
    }

    _addContactNumber(contact, index) {
        let row = new Gtk.ListBoxRow({
            activatable: true,
            selectable: true,
            visible: true
        });
        row.contact = contact;
        row.number = contact.numbers[index];
        this.list.add(row);

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6,
            visible: true
        });
        row.add(grid);

        if (index === 0) {
            let avatar = new Avatar(contact);
            avatar.valign = Gtk.Align.CENTER;
            grid.attach(avatar, 0, 0, 1, 2);

            let nameLabel = new Gtk.Label({
                label: GLib.markup_escape_text(contact.name, -1),
                halign: Gtk.Align.START,
                hexpand: true,
                visible: true
            });
            grid.attach(nameLabel, 1, 0, 1, 1);
        }

        let numLabel = new Gtk.Label({
            label: getNumberLabel(row.number),
            halign: Gtk.Align.START,
            hexpand: true,
            // TODO: rtl inverts margin-start so the number don't align
            margin_start: (index > 0) ? 38 : 0,
            margin_end: (index > 0) ? 38 : 0,
            visible: true
        });
        numLabel.get_style_context().add_class('dim-label');
        grid.attach(numLabel, 1, 1, 1, 1);

        return row;
    }

    _addContact(contact) {
        try {
            // HACK: fix missing contact names
            contact.name = contact.name || _('Unknown Contact');

            if (contact.numbers.length === 1) {
                return this._addContactNumber(contact, 0);
            }

            for (let i = 0, len = contact.numbers.length; i < len; i++) {
                this._addContactNumber(contact, i);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Get a dictionary of number-contact pairs for each selected phone number.
     */
    getSelected() {
        try {
            let selected = {};

            for (let row of this.list.get_selected_rows()) {
                selected[row.number.value] = row.contact;
            }

            return selected;
        } catch (e) {
            logError(e);
            return {};
        }
    }
});

