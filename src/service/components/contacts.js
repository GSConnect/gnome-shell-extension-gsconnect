// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const ByteArray = imports.byteArray; //todo port import

import * as Gio from "gi://Gio";
import * as GLib from "gi://GLib";
import * as GObject from "gi://GObject";

const Config = imports.config; //todo port import

var HAVE_EDS = true;
var EBook = null;
var EBookContacts = null;
var EDataServer = null;

try {
    EBook = imports.gi.EBook; //todo port import
    EBookContacts = imports.gi.EBookContacts; //todo port import
    EDataServer = imports.gi.EDataServer; //todo port import
} catch (e) {
    HAVE_EDS = false;
}


/**
 * A store for contacts
 */
var Store = GObject.registerClass({
    GTypeName: 'GSConnectContactsStore',
    Properties: {
        'context': GObject.ParamSpec.string(
            'context',
            'Context',
            'Used as the cache directory, relative to Config.CACHEDIR',
            GObject.ParamFlags.CONSTRUCT_ONLY | GObject.ParamFlags.READWRITE,
            null
        ),
    },
    Signals: {
        'contact-added': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
        'contact-removed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
        'contact-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class Store extends GObject.Object {

    _init(context = null) {
        super._init({
            context: context,
        });

        this._cacheData = {};
        this._edsPrepared = false;
    }

    /**
     * Parse an EContact and add it to the store.
     *
     * @param {EBookContacts.Contact} econtact - an EContact to parse
     * @param {string} [origin] - an optional origin string
     */
    async _parseEContact(econtact, origin = 'desktop') {
        try {
            const contact = {
                id: econtact.id,
                name: _('Unknown Contact'),
                numbers: [],
                origin: origin,
                timestamp: 0,
            };

            // Try to get a contact name
            if (econtact.full_name)
                contact.name = econtact.full_name;

            // Parse phone numbers
            const nums = econtact.get_attributes(EBookContacts.ContactField.TEL);

            for (const attr of nums) {
                const number = {
                    value: attr.get_value(),
                    type: 'unknown',
                };

                if (attr.has_type('CELL'))
                    number.type = 'cell';
                else if (attr.has_type('HOME'))
                    number.type = 'home';
                else if (attr.has_type('WORK'))
                    number.type = 'work';

                contact.numbers.push(number);
            }

            // Try and get a contact photo
            const photo = econtact.photo;

            if (photo) {
                if (photo.type === EBookContacts.ContactPhotoType.INLINED) {
                    const data = photo.get_inlined()[0];
                    contact.avatar = await this.storeAvatar(data);

                } else if (photo.type === EBookContacts.ContactPhotoType.URI) {
                    const uri = econtact.photo.get_uri();
                    contact.avatar = uri.replace('file://', '');
                }
            }

            this.add(contact, false);
        } catch (e) {
            logError(e, `Failed to parse VCard contact ${econtact.id}`);
        }
    }

    /*
     * AddressBook DBus callbacks
     */
    _onObjectsAdded(connection, sender, path, iface, signal, params) {
        try {
            const adds = params.get_child_value(0).get_strv();

            // NOTE: sequential pairs of vcard, id
            for (let i = 0, len = adds.length; i < len; i += 2) {
                try {
                    const vcard = adds[i];
                    const econtact = EBookContacts.Contact.new_from_vcard(vcard);
                    this._parseEContact(econtact);
                } catch (e) {
                    debug(e);
                }
            }
        } catch (e) {
            debug(e);
        }
    }

    _onObjectsRemoved(connection, sender, path, iface, signal, params) {
        try {
            const changes = params.get_child_value(0).get_strv();

            for (const id of changes) {
                try {
                    this.remove(id, false);
                } catch (e) {
                    debug(e);
                }
            }
        } catch (e) {
            debug(e);
        }
    }

    _onObjectsModified(connection, sender, path, iface, signal, params) {
        try {
            const changes = params.get_child_value(0).get_strv();

            // NOTE: sequential pairs of vcard, id
            for (let i = 0, len = changes.length; i < len; i += 2) {
                try {
                    const vcard = changes[i];
                    const econtact = EBookContacts.Contact.new_from_vcard(vcard);
                    this._parseEContact(econtact);
                } catch (e) {
                    debug(e);
                }
            }
        } catch (e) {
            debug(e);
        }
    }

    /*
     * SourceRegistryWatcher callbacks
     */
    async _onAppeared(watcher, source) {
        try {
            // Get an EBookClient and EBookView
            const uid = source.get_uid();
            const client = await EBook.BookClient.connect(source, null);
            const [view] = await client.get_view('exists "tel"', null);

            // Watch the view for changes to the address book
            const connection = view.get_connection();
            const objectPath = view.get_object_path();

            view._objectsAddedId = connection.signal_subscribe(
                null,
                'org.gnome.evolution.dataserver.AddressBookView',
                'ObjectsAdded',
                objectPath,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onObjectsAdded.bind(this)
            );

            view._objectsRemovedId = connection.signal_subscribe(
                null,
                'org.gnome.evolution.dataserver.AddressBookView',
                'ObjectsRemoved',
                objectPath,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onObjectsRemoved.bind(this)
            );

            view._objectsModifiedId = connection.signal_subscribe(
                null,
                'org.gnome.evolution.dataserver.AddressBookView',
                'ObjectsModified',
                objectPath,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onObjectsModified.bind(this)
            );

            view.start();

            // Store the EBook in a map
            this._ebooks.set(uid, {
                source: source,
                client: client,
                view: view,
            });
        } catch (e) {
            debug(e);
        }
    }

    _onDisappeared(watcher, source) {
        try {
            const uid = source.get_uid();
            const ebook = this._ebooks.get(uid);

            if (ebook === undefined)
                return;

            // Disconnect the EBookView
            if (ebook.view) {
                const connection = ebook.view.get_connection();
                connection.signal_unsubscribe(ebook.view._objectsAddedId);
                connection.signal_unsubscribe(ebook.view._objectsRemovedId);
                connection.signal_unsubscribe(ebook.view._objectsModifiedId);

                ebook.view.stop();
            }

            this._ebooks.delete(uid);
        } catch (e) {
            debug(e);
        }
    }

    async _initEvolutionDataServer() {
        try {
            if (this._edsPrepared)
                return;

            this._edsPrepared = true;
            this._ebooks = new Map();

            // Get the current EBooks
            const registry = await this._getESourceRegistry();

            for (const source of registry.list_sources('Address Book'))
                await this._onAppeared(null, source);

            // Watch for new and removed sources
            this._watcher = new EDataServer.SourceRegistryWatcher({
                registry: registry,
                extension_name: 'Address Book',
            });

            this._appearedId = this._watcher.connect(
                'appeared',
                this._onAppeared.bind(this)
            );
            this._disappearedId = this._watcher.connect(
                'disappeared',
                this._onDisappeared.bind(this)
            );
        } catch (e) {
            const service = Gio.Application.get_default();

            if (service !== null)
                service.notify_error(e);
            else
                logError(e);
        }
    }

    *[Symbol.iterator]() {
        const contacts = Object.values(this._cacheData);

        for (let i = 0, len = contacts.length; i < len; i++)
            yield contacts[i];
    }

    get contacts() {
        return Object.values(this._cacheData);
    }

    get context() {
        if (this._context === undefined)
            this._context = null;

        return this._context;
    }

    set context(context) {
        this._context = context;
        this._cacheDir = Gio.File.new_for_path(Config.CACHEDIR);

        if (context !== null)
            this._cacheDir = this._cacheDir.get_child(context);

        GLib.mkdir_with_parents(this._cacheDir.get_path(), 448);
        this._cacheFile = this._cacheDir.get_child('contacts.json');
    }

    /**
     * Save a ByteArray to file and return the path
     *
     * @param {ByteArray} contents - An image ByteArray
     * @return {string|undefined} File path or %undefined on failure
     */
    async storeAvatar(contents) {
        const md5 = GLib.compute_checksum_for_data(GLib.ChecksumType.MD5,
            contents);
        const file = this._cacheDir.get_child(`${md5}`);

        if (!file.query_exists(null)) {
            try {
                await file.replace_contents_bytes_async(
                    new GLib.Bytes(contents),
                    null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                debug(e, 'Storing avatar');
                return undefined;
            }
        }

        return file.get_path();
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {Object} query - A query object
     * @param {string} [query.name] - The contact's name
     * @param {string} query.number - The contact's number
     * @return {Object} A contact object
     */
    query(query) {
        // First look for an existing contact by number
        const contacts = this.contacts;
        const matches = [];
        const qnumber = query.number.toPhoneNumber();

        for (let i = 0, len = contacts.length; i < len; i++) {
            const contact = contacts[i];

            for (const num of contact.numbers) {
                const cnumber = num.value.toPhoneNumber();

                if (qnumber.endsWith(cnumber) || cnumber.endsWith(qnumber)) {
                    // If no query name or exact match, return immediately
                    if (!query.name || query.name === contact.name)
                        return contact;

                    // Otherwise we might find an exact name match that shares
                    // the number with another contact
                    matches.push(contact);
                }
            }
        }

        // Return the first match (pretty much what Android does)
        if (matches.length > 0)
            return matches[0];

        // No match; return a mock contact with a unique ID
        let id = GLib.uuid_string_random();

        while (this._cacheData.hasOwnProperty(id))
            id = GLib.uuid_string_random();

        return {
            id: id,
            name: query.name || query.number,
            numbers: [{value: query.number, type: 'unknown'}],
            origin: 'gsconnect',
        };
    }

    get_contact(position) {
        if (this._cacheData[position] !== undefined)
            return this._cacheData[position];

        return null;
    }

    /**
     * Add a contact, checking for validity
     *
     * @param {Object} contact - A contact object
     * @param {boolean} write - Write to disk
     */
    add(contact, write = true) {
        // Ensure the contact has a unique id
        if (!contact.id) {
            let id = GLib.uuid_string_random();

            while (this._cacheData[id])
                id = GLib.uuid_string_random();

            contact.id = id;
        }

        // Ensure the contact has an origin
        if (!contact.origin)
            contact.origin = 'gsconnect';

        // This is an updated contact
        if (this._cacheData[contact.id]) {
            this._cacheData[contact.id] = contact;
            this.emit('contact-changed', contact.id);

        // This is a new contact
        } else {
            this._cacheData[contact.id] = contact;
            this.emit('contact-added', contact.id);
        }

        // Write if requested
        if (write)
            this.save();
    }

    /**
     * Remove a contact by id
     *
     * @param {string} id - The id of the contact to delete
     * @param {boolean} write - Write to disk
     */
    remove(id, write = true) {
        // Only remove if the contact actually exists
        if (this._cacheData[id]) {
            delete this._cacheData[id];
            this.emit('contact-removed', id);

            // Write if requested
            if (write)
                this.save();
        }
    }

    /**
     * Lookup a contact for each address object in @addresses and return a
     * dictionary of address (eg. phone number) to contact object.
     *
     * { "555-5555": { "name": "...", "numbers": [], ... } }
     *
     * @param {Object[]} addresses - A list of address objects
     * @return {Object} A dictionary of phone numbers and contacts
     */
    lookupAddresses(addresses) {
        const contacts = {};

        // Lookup contacts for each address
        for (let i = 0, len = addresses.length; i < len; i++) {
            const address = addresses[i].address;

            contacts[address] = this.query({
                number: address,
            });
        }

        return contacts;
    }

    async clear() {
        try {
            const contacts = this.contacts;

            for (let i = 0, len = contacts.length; i < len; i++)
                await this.remove(contacts[i].id, false);

            await this.save();
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Update the contact store from a dictionary of our custom contact objects.
     *
     * @param {Object} json - an Object of contact Objects
     */
    async update(json = {}) {
        try {
            let contacts = Object.values(json);

            for (let i = 0, len = contacts.length; i < len; i++) {
                const new_contact = contacts[i];
                const contact = this._cacheData[new_contact.id];

                if (!contact || new_contact.timestamp !== contact.timestamp)
                    await this.add(new_contact, false);
            }

            // Prune contacts
            contacts = this.contacts;

            for (let i = 0, len = contacts.length; i < len; i++) {
                const contact = contacts[i];

                if (!json[contact.id])
                    await this.remove(contact.id, false);
            }

            await this.save();
        } catch (e) {
            debug(e, 'Updating contacts');
        }
    }

    /**
     * Fetch and update the contact store from its source.
     *
     * The default function initializes the EDS server, or logs a debug message
     * if EDS is unavailable. Derived classes should request an update from the
     * remote source.
     */
    async fetch() {
        try {
            if (this.context === null && HAVE_EDS)
                await this._initEvolutionDataServer();
            else
                throw new Error('Evolution Data Server not available');
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Load the contacts from disk.
     */
    async load() {
        try {
            const [contents] = await this._cacheFile.load_contents_async(null);
            this._cacheData = JSON.parse(ByteArray.toString(contents));
        } catch (e) {
            debug(e);
        } finally {
            this.notify('context');
        }
    }

    /**
     * Save the contacts to disk.
     */
    async save() {
        // EDS is handling storage
        if (this.context === null && HAVE_EDS)
            return;

        if (this.__cache_lock) {
            this.__cache_queue = true;
            return;
        }

        try {
            this.__cache_lock = true;

            const contents = new GLib.Bytes(JSON.stringify(this._cacheData, null, 2));
            await this._cacheFile.replace_contents_bytes_async(contents, null,
                false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            debug(e);
        } finally {
            this.__cache_lock = false;

            if (this.__cache_queue) {
                this.__cache_queue = false;
                this.save();
            }
        }
    }

    destroy() {
        if (this._watcher !== undefined) {
            this._watcher.disconnect(this._appearedId);
            this._watcher.disconnect(this._disappearedId);
            this._watcher = undefined;

            for (const ebook of this._ebooks.values())
                this._onDisappeared(null, ebook.source);

            this._edsPrepared = false;
        }
    }
});


/**
 * The service class for this component
 */
var Component = Store;

