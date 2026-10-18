// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {children} from '../utils/ui.js';


/**
 * Get a GdkPixbuf for {@link path}, allowing the corrupt JPEG's KDE Connect
 * sometimes sends. This function is synchronous.
 *
 * @param {string} path - A local file path
 * @param {number} size - Size in pixels
 * @param {scale} [scale] - Scale factor for the size
 * @returns {GdkPixbuf.Pixbuf|undefined} A pixbuf
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
 * Get a display number from {@link contact} for {@link address}.
 *
 * @param {object} contact - A contact object
 * @param {string} address - A phone number
 * @param {boolean} [markup] - Whether to escape the result for Pango markup
 * @returns {string} A (possibly) better display number for the address
 */
export function getDisplayNumber(contact, address, markup = true) {
    const escape = text => (markup ? GLib.markup_escape_text(text, -1) : text);

    for (const contactNumber of contact.numbers) {
        if (address?.equalsPhoneNumber(contactNumber.value))
            return escape(contactNumber.value);
    }
    return escape(address);
}


/**
 * Contact Avatar
 */
const AvatarCache = new WeakMap();

export const Avatar = GObject.registerClass({
    GTypeName: 'GSConnectContactAvatar',
}, class ContactAvatar extends Adw.Bin {

    _init(contact = null, size = 32) {
        super._init({valign: Gtk.Align.CENTER});

        this._avatar = new Adw.Avatar({size, show_initials: false});
        this.set_child(this._avatar);

        this.contact = contact;
    }

    get contact() {
        if (this._contact === undefined)
            this._contact = null;

        return this._contact;
    }

    set contact(contact) {
        this._contact = contact;

        // The text is only used by Adw.Avatar to pick a color; a group (no
        // contact) gets a random one
        this._avatar.text = contact?.name ?? GLib.uuid_string_random();
        this._avatar.icon_name = contact
            ? 'avatar-default-symbolic'
            : 'group-avatar-symbolic';
        this._avatar.custom_image = contact ? this._loadTexture() : null;
    }

    _loadTexture() {
        if (!this.contact.avatar)
            return null;

        // Check the cache
        let texture = AvatarCache.get(this.contact);

        // Try loading the pixbuf, at twice the size for HiDPI
        if (!texture) {
            const pixbuf = getPixbufForPath(
                this.contact.avatar,
                this._avatar.size,
                2
            );

            if (pixbuf) {
                texture = Gdk.Texture.new_for_pixbuf(pixbuf);
                AvatarCache.set(this.contact, texture);
            }
        }

        return texture ?? null;
    }
});


/**
 * A row for a contact address (usually a phone number).
 */
const AddressRow = GObject.registerClass({
    GTypeName: 'GSConnectContactsAddressRow',
}, class AddressRow extends Adw.ActionRow {

    _init(contact, index = 0) {
        super._init({activatable: true});

        this._index = index;
        this._number = contact.numbers[index];

        this.avatar = new Avatar();
        this.add_prefix(this.avatar);

        this.type_label = new Gtk.Label({label: _('Other')});
        this.type_label.add_css_class('dim-label');
        this.add_suffix(this.type_label);

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
            this.avatar.contact = contact;
            this.avatar.visible = true;

            this.title = GLib.markup_escape_text(contact.name, -1);
        } else {
            // Keep the numbers aligned, without repeating the avatar and name
            this.avatar.contact = null;
            this.avatar.opacity = 0;
            this.title = '';
        }

        this.subtitle = GLib.markup_escape_text(this.number.value, -1);

        if (this.number.type !== undefined)
            this.type_label.label = getNumberTypeLabel(this.number.type);
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
}, class ContactChooser extends Gtk.Box {

    _init(params) {
        super._init({orientation: Gtk.Orientation.VERTICAL});

        this._buildLayout();

        // Properties are applied after the children exist
        this.freeze_notify();
        Object.assign(this, params);
        this.thaw_notify();

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

    }

    _buildLayout() {
        this.entry = new Gtk.SearchEntry({
            placeholder_text: _('Type a phone number or name'),
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        this.entry.connect('search-changed', this._onSearchChanged.bind(this));
        this.append(this.entry);

        this.list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.MULTIPLE});
        this.list.add_css_class('contact-list');
        this.list.connect('row-activated', this._onNumberSelected.bind(this));

        // Placeholder
        const placeholder = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            vexpand: true,
        });
        placeholder.add_css_class('placeholder');
        const image = new Gtk.Image({
            icon_name: 'avatar-default-symbolic',
            pixel_size: 144,
        });
        image.add_css_class('placeholder-image');
        placeholder.append(image);

        const title = new Gtk.Label({label: _('No contacts')});
        title.add_css_class('placeholder-title');
        placeholder.append(title);

        placeholder.append(new Gtk.LinkButton({
            label: _('Help'),
            uri: 'https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Help#contacts-dont-sync',
        }));
        this.list.set_placeholder(placeholder);

        this.scrolled = new Gtk.ScrolledWindow({
            child: this.list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            hexpand: true,
            vexpand: true,
        });
        this.scrolled.add_css_class('contact-window');
        this.append(this.scrolled);
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
            for (const row of children(this.list))
                this.list.remove(row);
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
        for (const row of children(this.list)) {
            if (row.contact.id === id)
                this.list.remove(row);
        }
    }

    _onContactChanged(store, id) {
        this._onContactRemoved(store, id);
        this._onContactAdded(store, id);
    }

    /**
     * Disconnect from the contact store. Must be called before the chooser is
     * discarded.
     */
    cleanup() {
        this.store = null;
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

            // ...or if we already do, then update it
            } else {
                const address = entry.text;

                // Update contact object
                dynamic.contact.name = address;
                dynamic.contact.numbers[0].value = address;

                // Update UI
                dynamic.title = GLib.markup_escape_text(_('Send to %s').format(address), -1);
                dynamic.subtitle = GLib.markup_escape_text(address, -1);
            }

        // ...otherwise remove any dynamic contact that's been created
        } else if (dynamic && dynamic.__tmp) {
            this.list.remove(dynamic);
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    // GtkListBox::row-activated
    _onNumberSelected(box, row) {
        if (row === null)
            return;

        // Emit the number
        const address = row.number.value;
        this.emit('number-selected', address);

        // Reset the contact list
        this.entry.text = '';
        this.list.unselect_all();
        this.scrolled.vadjustment.value = 0;
    }

    _filter(row) {
        // Dynamic contact always shown
        if (row.__tmp)
            return true;

        const query = row.get_parent()._entry;

        // Show contact if text is substring of name
        const queryName = query.toLocaleLowerCase();

        if (row.contact.name.toLocaleLowerCase().includes(queryName))
            return true;

        // Show contact if text is substring of number
        const queryNumber = query.toPhoneNumber();

        if (queryNumber.length) {
            for (const number of row.contact.numbers) {
                if (number.value.toPhoneNumber().includes(queryNumber))
                    return true;
            }

        // Query is effectively empty
        } else if (/^0+/.test(query)) {
            return true;
        }

        return false;
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
        this.list.append(row);

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
            const selected = {};

            for (const row of this.list.get_selected_rows())
                selected[row.number.value] = row.contact;

            return selected;
        } catch (e) {
            logError(e);
            return {};
        }
    }
});
