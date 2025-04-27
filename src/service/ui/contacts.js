// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

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
 * AddressRow - A UI component representing a contact's address (usually a phone number).
 *
 * This class displays a contact's name, phone number, and phone number type
 * inside an Adw.ActionRow for use in lists or forms.
 *
 * @class AddressRow
 * @extends Adw.ActionRow
 * @param {object} contact - The contact object
 * @param {number} [index=0] - The index of the phone number in the contact's numbers array
 */
const AddressRow = GObject.registerClass({
    GTypeName: 'GSConnectContactsAddressRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contacts-address-row.ui',
    Children: ['avatar', 'type-label'],
}, class AddressRow extends Adw.ActionRow {

    _init(contact, index = 0) {
        super._init();

        this._index = index;
        this._number = contact.numbers[index];
        this.contact = contact;
    }

    /**
     * Getter and setter for contact object associated with this row.
     *
     * @type {Object} The contact object or null if not set.
     */
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
        
        if (this.number.type !== undefined)
            this.type_label.label = getNumberTypeLabel(this.number.type);
    }

    /**
     * Get the phone number object associated with this row.
     *
     * @type {{value: string, type: string}} The phone number object.
     *          If no number is set, returns {value: 'unknown', type: 'unknown'}.
     */
    get number() {
        if (this._number === undefined)
            return {value: 'unknown', type: 'unknown'};

        return this._number;
    }
});

/**
 * A contact chooser dialog for selecting phone numbers from contacts.
 *
 * @class ContactChooser
 * @extends Adw.NavigationPage
 * @emits number-selected
 * @property {Object} device - The device associated with this contact chooser.
 * @property {Object} store - The contacts store used to retrieve and manage contacts.
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
        'stack', 'scrolled', 'not-found-page', 'list', 
        'header-bar', 
            
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
        
        // Make sure we're using the correct contacts store
        this.search_bar.bind_property(
            'search-mode-enabled',
            this.button_search,
            'active',
            GObject.BindingFlags.SYNC_CREATE
        );            
        
        this.button_search.connect("clicked", this._searchButtonClicked.bind(this));

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
        
        this.search_entry.connect("search-changed", () => {
            this.results_count = -1;
            this.list.invalidate_filter();
            if (this.results_count === -1) 
                this.stack.visible_child = this.not_found_page;
            else if (this.search_bar.search_mode_enabled) 
                this.stack.visible_child = this.scrolled;
        });

        // Set the same controller for stack pages and header bar's button.
        const button_controller = new Gtk.EventControllerKey();
        const list_controller = new Gtk.EventControllerKey();
        const not_found_controller = new Gtk.EventControllerKey(); 
        not_found_controller.connect('key-pressed', this._onKeyPress.bind(this));
        button_controller.connect('key-pressed', this._onKeyPress.bind(this));
        list_controller.connect('key-pressed', this._onKeyPress.bind(this));
        this.not_found_page.add_controller(not_found_controller);
        this.button_search.add_controller(button_controller);
        this.list.add_controller(list_controller);
    }
    /**
     * Getter and Setter for the contact store.
     *
     * @type {Object} The current contact store.
     */
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
    
    /**
     * Getter and Setter for the back button visibility.
     *
     * @type {Object} store - The new contact store.
     */
    get show_back_button() {
        return this.header_bar.show_back_button;
    }

    set show_back_button(value) {
        this.header_bar.show_back_button = value; 
    }

    /**
     * Handles when a new contact is added to the store.
     *
     * @param {Object} store - The contact store.
     * @param {string} id - The ID of the added contact.
     */
    _onContactAdded(store, id) {
        const contact = this.store.get_contact(id);
        this._addContact(contact);
    }

    /**
     * Handles when a contact is removed from the store.
     *
     * @param {Object} store - The contact store.
     * @param {string} id - The ID of the removed contact.
     */
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

    /**
     * Handles when a contact is updated in the store.
     *
     * @param {Object} store - The contact store.
     * @param {string} id - The ID of the changed contact.
     */
    _onContactChanged(store, id) {
        this._onContactRemoved(store, id);
        this._onContactAdded(store, id);
    }
    
    /**
     * Cleans up the store when the dialog is destroyed.
     *
     * @param {ContactChooser} chooser - The instance being destroyed.
     */
    _onDestroy(chooser) {
        chooser.store = null;
    }

    /**
     * Updates the dynamic search results based on the search entry value.
     *
     * @param {Gtk.Entry} entry - The search entry widget.
     */
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

    /**
     * Emits the number-selected signal when a row is activated.
     *
     * @param {AddressRow} row - The activated row.
     * 
     * @returns {void}
     */
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

    /**
     * Filters the contacts based on the current search entry text.
     *
     * @param {AddressRow} row - A row in the contact list.
     * @returns {boolean} Whether the row matches the filter.
     */
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

    /**
     * Sorts contact rows alphabetically, giving priority to dynamic entries.
     *
     * @param {AddressRow} row1 - First contact row.
     * @param {AddressRow} row2 - Second contact row.
     * @returns {number} Sorting order between the two rows.
     */
    _sort(row1, row2) {
        if (row1.__tmp)
            return -1;

        if (row2.__tmp)
            return 1;

        return row1.contact.name.localeCompare(row2.contact.name);
    }

    /**
     * Populates the contact list with entries from the store.
     * 
     * @returns {void}
     */
    _populate() {
        // Add each contact
        const contacts = this.store.contacts;

        for (let i = 0, len = contacts.length; i < len; i++)
            this._addContact(contacts[i]);
    }

    /**
     * Adds a new contact number to the address book.
     *
     * @param {Object} contact The contact object containing the phone numbers.
     * @param {number} index The index of the phone number in the `contact.numbers` array.
     *
     * @returns {AddressRow} The newly created row for the contact number.
     */
    _addContactNumber(contact, index) {
        const row = new AddressRow(contact, index);
        row.connect('activated', this._onNumberSelected.bind(this));
        this.list.append(row);
        this.row_list.push(row);
        return row;
    }

    /**
     * Adds a new contact to the address book.
     *
     * @param {Object} contact The contact object to add.
     * 
     * @returns {void}
     */
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
     * Handles click events on the search button.
     * 
     * @returns {void}
     */
    _searchButtonClicked() {
        this.search_bar.search_mode_enabled = !this.search_bar.search_mode_enabled;
        if (!this.search_bar.search_mode_enabled) {
            this.search_entry.set_key_capture_widget(null);
        } else {
            this.search_entry.set_key_capture_widget(this);
        }
    }
    
    /**
     * Handles key press events in the search entry field.
     *
     * @param {Gtk.EventController} controller The event controller that triggered this event.
     * @param {number} keyval The key value of the pressed key.
     * @param {number} keycode The key code of the pressed key.
     * @param {number} state The state of the modifier keys (Shift, Control, Alt).
     *
     * @returns {Gdk.EventSequence} Whether to stop handling other event handlers for this event sequence.
     */
    _onKeyPress(controller, keyval, keycode, state)  {
        this._searchButtonClicked();
        const char = String.fromCharCode(keyval);
        if (/^[a-zA-Z0-9]$/.test(char)) { 
            this.search_entry.text = char;
            this.search_entry.set_position(-1);
        }
        return Gdk.EVENT_STOP;
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
