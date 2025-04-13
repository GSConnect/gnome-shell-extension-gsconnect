// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

/**
 * Return a random color
 *
 * @param {*} [salt] - If not %null, will be used as salt for generating a color
 * @param {number} alpha - A value in the [0...1] range for the alpha channel
 * @returns {Gdk.RGBA} A new Gdk.RGBA object generated from the input
 */
function randomRGBA(salt = null, alpha = 1.0) {
    let red, green, blue;

    if (salt !== null) {
        const hash = new GLib.Variant('s', `${salt}`).hash();
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
 * @param {Gdk.RGBA} rgba - A GdkRGBA object
 * @returns {number} The relative luminance of the color
 */
function relativeLuminance(rgba) {
    const {red, green, blue} = rgba;

    const R = (red > 0.03928) ? red / 12.92 : Math.pow(((red + 0.055) / 1.055), 2.4);
    const G = (green > 0.03928) ? green / 12.92 : Math.pow(((green + 0.055) / 1.055), 2.4);
    const B = (blue > 0.03928) ? blue / 12.92 : Math.pow(((blue + 0.055) / 1.055), 2.4);

    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}


/**
 * Get a GdkRGBA contrasted for the input
 * See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 *
 * @param {Gdk.RGBA} rgba - A GdkRGBA object for the background color
 * @returns {Gdk.RGBA} A GdkRGBA object for the foreground color
 */
function getFgRGBA(rgba) {
    const bgLuminance = relativeLuminance(rgba);
    const lightContrast = (0.07275541795665634 + 0.05) / (bgLuminance + 0.05);
    const darkContrast = (bgLuminance + 0.05) / (0.0046439628482972135 + 0.05);

    const value = (darkContrast > lightContrast) ? 0.06 : 0.94;
    return new Gdk.RGBA({red: value, green: value, blue: value, alpha: 0.5});
}


/**
 * Get a GdkPixbuf for @path, allowing the corrupt JPEG's KDE Connect sometimes
 * sends. This function is synchronous.
 *
 * @param {string} path - A local file path
 * @param {number} size - Size in pixels
 * @param {scale} [scale] - Scale factor for the size
 * @returns {Gdk.Pixbuf} A pixbuf
 */
function getPixbufForPath(path, size, scale = 1.0) {
    let data, loader;

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

    const pixbuf = loader.get_pixbuf();

    // Scale to monitor
    size = Math.floor(size * scale);
    return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
}

/**
 * Retrieve the GdkPixbuf for a named icon
 *
 * @param {string} name - The icon name to load
 * @param {number} size - The pixel size requested
 * @param {number} scale - The scale multiplier
 * @param {string} bgColor - The background color the icon will be used against
 * @returns {GdkPixbuf.pixbuf|null} The icon image
 */
function getPixbufForIcon(name, size, scale, bgColor) {
    const color = getFgRGBA(bgColor);
    const theme = Gtk.IconTheme.get_default();
    const info = theme.lookup_icon_for_scale(
        name,
        size,
        scale,
        Gtk.IconLookupFlags.FORCE_SYMBOLIC
    );

    return info.load_symbolic(color, null, null, null)[0];
}


/**
 * Return a localized string for a phone number type
 * See: http://www.ietf.org/rfc/rfc2426.txt
 *
 * @param {string} type - An RFC2426 phone number type
 * @returns {string} A localized string like 'Mobile'
 */
function getNumberTypeLabel(type) {
    if (type.includes('fax'))
        // TRANSLATORS: A fax number
        return _('Fax');

    if (type.includes('work'))
        // TRANSLATORS: A work or office phone number
        return _('Work');

    if (type.includes('cell'))
        // TRANSLATORS: A mobile or cellular phone number
        return _('Mobile');

    if (type.includes('home'))
        // TRANSLATORS: A home phone number
        return _('Home');

    // TRANSLATORS: All other phone number types
    return _('Other');
}

/**
 * Get a display number from @contact for @address.
 *
 * @param {object} contact - A contact object
 * @param {string} address - A phone number
 * @returns {string} A (possibly) better display number for the address
 */
export function getDisplayNumber(contact, address) {
    const number = address.toPhoneNumber();

    for (const contactNumber of contact.numbers) {
        const cnumber = contactNumber.value.toPhoneNumber();

        if (number.endsWith(cnumber) || cnumber.endsWith(number))
            return GLib.markup_escape_text(contactNumber.value, -1);
    }

    return GLib.markup_escape_text(address, -1);
}

/**
 * A row for a contact address (usually a phone number).
 */
const AddressRow = GObject.registerClass({
    GTypeName: 'GSConnectContactsAddressRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contacts-address-row.ui',
    Children: ['avatar'],
}, class AddressRow extends Adw.ActionRow {

    _init(contact, index = 0) {
        super._init();

        this._index = index;
        this._number = contact.numbers[index];
        this.contact = contact;
    }

    get contact() {
        if (this._contact === undefined)
            this._contact = null;

        return this._contact;
    }

    set contact(contact) {
        if (this.contact === contact)
            return;

        this._contact = contact;

        if (this._index === 0) {
            this.avatar.text = contact.name
            this.title = GLib.markup_escape_text(contact.name, -1);
        }

        this.subtitle = GLib.markup_escape_text(this.number.value, -1);
        /*
        if (this.number.type !== undefined)
            this.type_label.label = getNumberTypeLabel(this.number.type);
        */
    }

    get number() {
        if (this._number === undefined)
            return {value: 'unknown', type: 'unknown'};

        return this._number;
    }
});


/**
 * A widget for selecting contact addresses (usually phone numbers)
 */
export const ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'store': GObject.ParamSpec.object(
            'store',
            'Store',
            'The contacts store',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            GObject.Object
        ),
    },
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contact-chooser.ui',
    Children: [
        'button-search', 'search-bar', 'search-entry',
        'stack', 'scrolled', 'not-found-page', 'list'
    ],
}, class ContactChooser extends Adw.NavigationPage {

    _init(params) {
        super._init(params);

        // Setup the contact list
        this.list._entry = this.search_entry.text;
        this.list.set_filter_func(this._filter.bind(this));
        this.list.set_sort_func(this._sort);
        this.row_list = [];
        this.selected_rows = {}
        
        // Make sure we're using the correct contacts store
        this.device.bind_property(
            'contacts',
            this,
            'store',
            GObject.BindingFlags.SYNC_CREATE
        );
        
        this.search_entry.set_key_capture_widget(this);

        this.button_search.connect("clicked", () => {
            this.search_bar.search_mode_enabled = ! this.search_bar.search_mode_enabled;
        });

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
        
        this.search_entry.connect("search-changed", () => {
            this.results_count = -1;
            this.list.invalidate_filter();
            if (this.results_count === -1) this.stack.visible_child = this.not_found_page;
            else if (this.search_bar.search_mode_enabled) this.stack.visible_child = this.scrolled;
        });
        /*
        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', () => {
            print("ok");
            return Gdk.EVENT_STOP;
        });

        this.add_controller(keyController);

        this.grab_focus();
        */
    }

    get store() {
        if (this._store === undefined)
            this._store = null;

        return this._store;
    }

    set store(store) {
        if (this.store === store)
            return;

        // Unbind the old store
        if (this._store) {
            // Disconnect from the store
            this._store.disconnect(this._contactAddedId);
            this._store.disconnect(this._contactRemovedId);
            this._store.disconnect(this._contactChangedId);

            // Clear the contact list
            this.row_list.forEach(row => {
                this.list.remove(row);
                row.run_dispose();
            });
            this.row_list = [];
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

    /*
     * ContactStore Callbacks
     */
    _onContactAdded(store, id) {
        const contact = this.store.get_contact(id);
        this._addContact(contact);
    }

    _onContactRemoved(store, id) {
        let removed_row = null;
        let new_row_list = []
        this.row_list.forEach(row => {
            if (row.contact.id === id) {
                removed_row = row;
            } else {
                new_row_list.push(row);
            }
        });
        this.list.remove(removed_row);
        removed_row.run_dispose();
        this.row_list = new_row_list;
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
                dynamic = new AddressRow({
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(entry.text),
                    numbers: [{type: 'unknown', value: entry.text}],
                });
                dynamic.__tmp = true;
                this.list.append(dynamic);
                this.row_list.push(dynamic);

            // ...or if we already do, then update it
            } else {
                const address = entry.text;

                // Update contact object
                dynamic.contact.name = address;
                dynamic.contact.numbers[0].value = address;

                // Update UI
                dynamic.name_label.label = _('Send to %s').format(address);
                dynamic.address_label.label = address;
            }

        // ...otherwise remove any dynamic contact that's been created
        } else if (dynamic && dynamic.__tmp) {
            dynamic.destroy();
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    // GtkListBox::row-activated
    _onNumberSelected(row) {
        if (row === undefined)
            return;

        // Emit the number
        const address = row.number.value;
        this.selected_rows = {};
        this.selected_rows[row.number.value] = address;
        this.emit('number-selected', address);

        // Reset the contact list
        this.search_entry.text = '';
        this.list.select_row(null);
        this.scrolled.vadjustment.value = 0;
    }

    _filter(row) {
        const re = new RegExp(this.search_entry.text, "i");
        let match = re.test(row.title);
        if (match) 
            this.results_count++;
        else {
            match = re.test(row.subtitle)
            if (match) 
                this.results_count++;
            
        }
        return match;
    }

    _sort(row1, row2) {
        if (row1.__tmp)
            return -1;

        if (row2.__tmp)
            return 1;

        return row1.contact.name.localeCompare(row2.contact.name);
    }

    _populate() {
        // Add each contact
        const contacts = this.store.contacts;

        for (let i = 0, len = contacts.length; i < len; i++)
            this._addContact(contacts[i]);
    }

    _addContactNumber(contact, index) {
        const row = new AddressRow(contact, index);
        row.connect('activated', this._onNumberSelected.bind(this));
        this.list.append(row);
        this.row_list.push(row);
        return row;
    }

    _addContact(contact) {
        try {
            // HACK: fix missing contact names
            if (contact.name === undefined)
                contact.name = _('Unknown Contact');

            if (contact.numbers.length === 1)
                return this._addContactNumber(contact, 0);

            for (let i = 0, len = contact.numbers.length; i < len; i++)
                this._addContactNumber(contact, i);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Get a dictionary of number-contact pairs for each selected phone number.
     *
     * @returns {object[]} A dictionary of contacts
     */
    getSelected() {
        try {
            return this.selected_rows;
        } catch (e) {
            logError(e);
            return {};
        }
    }
});
