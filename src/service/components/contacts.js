'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

var HAVE_EDS = true;

try {
    var EBook = imports.gi.EBook;
    var EBookContacts = imports.gi.EBookContacts;
    var EDataServer = imports.gi.EDataServer;
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
            'Used as the cache directory, relative to gsconnect.cachedir',
            GObject.ParamFlags.CONSTRUCT_ONLY | GObject.ParamFlags.READWRITE,
            null
        )
    },
    Signals: {
        'contact-added': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        },
        'contact-removed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        },
        'contact-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        }
    }
}, class Store extends GObject.Object {

    _init(context = null) {
        super._init({
            context: context
        });

        this.__cache_data = {};

        // If Evolution Data Server is available, load it now
        if (context === null && HAVE_EDS) {
            this._ebooks = new Map();
            this._initEvolutionDataServer();
        }
    }

    /**
     * Parse an EContact and return a small Object
     *
     * @param {EBookContacts.Contact} econtact - an EContact to parse
     * @param {string} [origin] - an optional origin string
     * @returns {Object} - a small JSON serializable object
     */
    async _parseEContact(econtact, origin = 'desktop') {
        try {
            let contact = {
                id: econtact.id,
                name: _('Unknown Contact'),
                numbers: [],
                origin: origin,
                timestamp: 0
            };

            // Try to get a contact name
            if (econtact.full_name)
                contact.name = econtact.full_name;

            // Parse phone numbers
            let nums = econtact.get_attributes(EBookContacts.ContactField.TEL);

            for (let attr of nums) {
                let number = {
                    value: attr.get_value(),
                    type: 'unknown'
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
            let photo = econtact.photo;

            if (photo) {
                if (photo.type === EBookContacts.ContactPhotoType.INLINED) {
                    let data = photo.get_inlined()[0];
                    contact.avatar = await this.storeAvatar(data);

                } else if (photo.type === EBookContacts.ContactPhotoType.URI) {
                    let uri = econtact.photo.get_uri();
                    contact.avatar = uri.replace('file://', '');
                }
            }

            return contact;
        } catch (e) {
            logError(e, `Failed to parse VCard contact ${econtact.id}`);
            return undefined;
        }
    }

    /*
     * EDS Helpers
     */
    _getEBookClient(source, cancellable = null) {
        return new Promise((resolve, reject) => {
            EBook.BookClient.connect(source, 0, cancellable, (source, res) => {
                try {
                    resolve(EBook.BookClient.connect_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _getEBookView(client, query = '', cancellable = null) {
        return new Promise((resolve, reject) => {
            client.get_view(query, cancellable, (client, res) => {
                try {
                    resolve(client.get_view_finish(res)[1]);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _getEContacts(client, query = '', cancellable = null) {
        return new Promise((resolve, reject) => {
            client.get_contacts(query, cancellable, (client, res) => {
                try {
                    resolve(client.get_contacts_finish(res)[1]);
                } catch (e) {
                    debug(e);
                    reject([]);
                }
            });
        });
    }

    _getESourceRegistry(cancellable = null) {
        return new Promise ((resolve, reject) => {
            EDataServer.SourceRegistry.new(cancellable, (registry, res) => {
                try {
                    resolve(EDataServer.SourceRegistry.new_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /*
     * AddressBook DBus callbacks
     */
    async _onObjectsAdded(connection, sender, path, iface, signal, params) {
        try {
            let adds = params.get_child_value(0).get_strv();

            // NOTE: sequential pairs of vcard, id
            for (let i = 0, len = adds.length; i < len; i += 2) {
                try {
                    let vcard = adds[i];
                    let econtact = EBookContacts.Contact.new_from_vcard(vcard);
                    let contact = await this._parseEContact(econtact);

                    if (contact !== undefined) {
                        this.add(contact, false);
                    }
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
            let changes = params.get_child_value(0).get_strv();

            for (let id of changes) {
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

    async _onObjectsModified(connection, sender, path, iface, signal, params) {
        try {
            let changes = params.get_child_value(0).get_strv();

            // NOTE: sequential pairs of vcard, id
            for (let i = 0, len = changes.length; i < len; i += 2) {
                try {
                    let vcard = changes[i];
                    let econtact = EBookContacts.Contact.new_from_vcard(vcard);
                    let contact = await this._parseEContact(econtact);

                    if (contact !== undefined) {
                        this.add(contact, false);
                    }
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
            let uid = source.get_uid();
            let client = await this._getEBookClient(source);
            let view = await this._getEBookView(client, 'exists "tel"');

            // Watch the view for changes to the address book
            let connection = view.get_connection();
            let objectPath = view.get_object_path();

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
                view: view
            });
        } catch (e) {
            debug(e);
        }
    }

    _onDisappeared(watcher, source) {
        try {
            let uid = source.get_uid();
            let ebook = this._ebooks.get(uid);

            if (ebook === undefined)
                return;

            // Disconnect and dispose the EBookView
            if (ebook.view) {
                let connection = ebook.view.get_connection();
                connection.signal_unsubscribe(ebook.view._objectsAddedId);
                connection.signal_unsubscribe(ebook.view._objectsRemovedId);
                connection.signal_unsubscribe(ebook.view._objectsModifiedId);
                ebook.view.stop();

                ebook.view.run_dispose();
                ebook.view = null;
            }

            // Dispose the EBookClient
            if (ebook.client) {
                ebook.client.run_dispose();
                ebook.client = null;
            }

            // Drop the EBook
            this._ebooks.delete(uid);
        } catch (e) {
            debug(e);
        }
    }

    async _initEvolutionDataServer() {
        try {
            // Get the current EBooks
            let registry = await this._getESourceRegistry();

            for (let source of registry.list_sources('Address Book')) {
                await this._onAppeared(null, source);
            }

            // Watch for new and removed sources
            this._watcher = new EDataServer.SourceRegistryWatcher({
                registry: registry,
                extension_name: 'Address Book'
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
            logError(e);
        }
    }

    *[Symbol.iterator]() {
        let contacts = this.contacts;

        for (let i = 0, len = contacts.length; i < len; i++) {
            yield contacts[i];
        }
    }

    get contacts() {
        return Object.values(this.__cache_data);
    }

    get context() {
        if (this._context === undefined) {
            this._context = null;
        }

        return this._context;
    }

    set context(context) {
        this._context = context;

        if (context === null) {
            this.__cache_dir = Gio.File.new_for_path(gsconnect.cachedir);
        } else {
            this.__cache_dir = Gio.File.new_for_path(
                GLib.build_filenamev([gsconnect.cachedir, context])
            );
        }

        GLib.mkdir_with_parents(this.__cache_dir.get_path(), 448);
        this.__cache_file = this.__cache_dir.get_child('contacts.json');
    }

    /**
     * Save a ByteArray to file and return the path
     *
     * @param {ByteArray} contents - An image ByteArray
     * @return {string|undefined} - File path or %undefined on failure
     */
    storeAvatar(contents) {
        return new Promise((resolve, reject) => {
            let md5 = GLib.compute_checksum_for_data(
                GLib.ChecksumType.MD5,
                contents
            );
            let file = this.__cache_dir.get_child(`${md5}`);

            if (file.query_exists(null)) {
                resolve(file.get_path());
            } else {
                file.replace_contents_bytes_async(
                    new GLib.Bytes(contents),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (file, res) => {
                        try {
                            file.replace_contents_finish(res);
                            resolve(file.get_path());
                        } catch (e) {
                            debug(e, 'Storing avatar');
                            resolve(undefined);
                        }
                    }
                );
            }
        });
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {object} query - A query object
     * @param {string} [query.name] - The contact's name
     * @param {string} query.number - The contact's number
     * @return {object} - A contact object
     */
    query(query) {
        // First look for an existing contact by number
        let contacts = this.contacts;
        let matches = [];
        let qnumber = query.number.toPhoneNumber();

        for (let i = 0, len = contacts.length; i < len; i++) {
            let contact = contacts[i];

            for (let num of contact.numbers) {
                let cnumber = num.value.toPhoneNumber();

                if (qnumber.endsWith(cnumber) || cnumber.endsWith(qnumber)) {
                    // If no query name or exact match, return immediately
                    if (!query.name || query.name === contact.name) {
                        return contact;
                    }

                    // Otherwise we might find an exact name match that shares
                    // the number with another contact
                    matches.push(contact);
                }
            }
        }

        // Return the first match (pretty much what Android does)
        if (matches.length > 0) return matches[0];

        // No match; return a mock contact with a unique ID
        let id = GLib.uuid_string_random();
        while (this.__cache_data.hasOwnProperty(id)) {
            id = GLib.uuid_string_random();
        }

        return {
            id: id,
            name: query.name || query.number,
            numbers: [{value: query.number, type: 'unknown'}],
            origin: 'gsconnect'
        };
    }

    get_contact(position) {
        try {
            return (this.__cache_data[position]) ? this.__cache_data[position] : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Add a contact, checking for validity
     *
     * @param {object} contact - A contact object
     * @param {boolean} write - Write to disk
     */
    add(contact, write = true) {
        // Ensure the contact has a unique id
        if (!contact.id) {
            let id = GLib.uuid_string_random();

            while (this.__cache_data[id]) {
                id = GLib.uuid_string_random();
            }

            contact.id = id;
        }

        // Ensure the contact has an origin
        if (!contact.origin) {
            contact.origin = 'gsconnect';
        }

        // This is an updated contact
        if (this.__cache_data[contact.id]) {
            this.__cache_data[contact.id] = contact;
            this.emit('contact-changed', contact.id);

        // This is a new contact
        } else {
            this.__cache_data[contact.id] = contact;
            this.emit('contact-added', contact.id);
        }

        // Write if requested
        if (write) {
            this.save();
        }
    }

    /**
     * Remove a contact by id
     *
     * @param {string} id - The id of the contact to delete
     * @param {boolean} write - Write to disk
     */
    remove(id, write = true) {
        // Only remove if the contact actually exists
        if (this.__cache_data[id]) {
            delete this.__cache_data[id];
            this.emit('contact-removed', id);

            // Write if requested
            if (write) {
                this.save();
            }
        }
    }

    /**
     * Lookup a contact for each address object in @addresses and return a
     * dictionary of address (eg. phone number) to contact object.
     *
     * { "555-5555": { "name": "...", "numbers": [], ... } }
     *
     * @param {Array of object} addresses - A list of address objects
     * @return {object} - A dictionary of phone numbers and contacts
     */
    lookupAddresses(addresses) {
        let contacts = {};

        // Lookup contacts for each address
        for (let i = 0, len = addresses.length; i < len; i++) {
            let address = addresses[i].address;

            contacts[address] = this.query({
                number: address
            });
        }

        return contacts;
    }

    async clear() {
        try {
            let contacts = this.contacts;

            for (let i = 0, len = contacts.length; i < len; i++) {
                await this.remove(contacts[i].id, false);
            }

            await this.save();
        } catch (e) {
            debug(e, 'Clearing contacts');
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
                let new_contact = contacts[i];
                let contact = this.__cache_data[new_contact.id];

                if (!contact || new_contact.timestamp !== contact.timestamp) {
                    await this.add(new_contact, false);
                }
            }

            // Prune contacts
            contacts = this.contacts;

            for (let i = 0, len = contacts.length; i < len; i++) {
                let contact = contacts[i];

                if (!json[contact.id]) {
                    await this.remove(contact.id, false);
                }
            }

            await this.save();
        } catch (e) {
            debug(e, 'Updating contacts');
        }
    }

    /**
     * Fetch and update the contact store from its source. The default function
     * simply logs a debug message if EDS is unavailable, while derived classes
     * should request an update from the remote source.
     */
    async fetch() {
        try {
            if (HAVE_EDS === false) {
                throw new Error('Evolution Data Server not available');
            }
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Load the contacts from disk.
     */
    async load() {
        try {
            this.__cache_data = await JSON.load(this.__cache_file);
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
        if (this.context === null && HAVE_EDS) {
            return;
        }

        if (this.__cache_lock) {
            this.__cache_queue = true;
            return;
        }

        try {
            this.__cache_lock = true;
            await JSON.dump(this.__cache_data, this.__cache_file);
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
        if (this.__disposed === undefined) {
            this.__disposed = true;

            if (HAVE_EDS) {
                this._watcher.disconnect(this._appearedId);
                this._watcher.disconnect(this._disappearedId);
                this._watcher.run_dispose();

                for (let ebook of this._ebooks.values()) {
                    this._onDisappeared(null, ebook.source);
                }
            }

            this.run_dispose();
        }
    }
});


/**
 * The service class for this component
 */
var Component = Store;

