'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


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
            ''
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

        // Automatically prepare the desktop store
        if (context === null) {
            this.prepare();
        }
    }

    async __cache_write() {
        if (this.__cache_lock) {
            this.__cache_queue = true;
            return;
        }

        try {
            this.__cache_lock = true;
            await JSON.dump(this.__cache_data, this.__cache_file);
        } catch (e) {
            warning(e);
        } finally {
            this.__cache_lock = false;

            if (this.__cache_queue) {
                this.__cache_queue = false;
                this.__cache_write();
            }
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
        return this._context || null;
    }

    set context(context) {
        this._context = context;

        if (context === null) {
            // Create a re-usable launcher for folks.py
            this._launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            this._launcher.setenv('FOLKS_BACKENDS_DISABLED', 'telepathy', true);

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
            let md5 = GLib.compute_checksum_for_data(GLib.ChecksumType.MD5, contents);
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
                            warning(e, 'Storing avatar');
                            resolve(undefined);
                        }
                    }
                );
            }
        });
    }

    // TODO: ensure this can only be called once
    async prepare() {
        try {
            this.__cache_data = await JSON.load(this.__cache_file);
        } catch (e) {
            debug(e);
        } finally {
            this.notify('context');
        }
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
        } else {
            this.__cache_data[contact.id] = contact;
            this.emit('contact-added', contact.id);
        }

        // Write if requested
        if (write) {
            this.__cache_write();
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
                this.__cache_write();
            }
        }
    }

    async clear() {
        try {
            let contacts = this.contacts;

            for (let i = 0, len = contacts.length; i < len; i++) {
                await this.remove(contacts[i].id, false);
            }

            await this.__cache_write();
        } catch (e) {
            warning(e, 'Clearing contacts');
        }
    }

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

            await this.__cache_write();
        } catch (e) {
            warning(e, 'Updating contacts');
        }
    }

    async _loadFolks() {
        try {
            let folks = await new Promise((resolve, reject) => {
                let proc = this._launcher.spawnv([
                    gsconnect.extdatadir + '/service/components/folks.py'
                ]);

                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        let [, stdout, stderr] = proc.communicate_utf8_finish(res);

                        if (stderr.length > 0) {
                            throw new Error(stderr);
                        }

                        resolve(JSON.parse(stdout));
                    } catch (e) {
                        // format python errors
                        e.stack = e.message;
                        e.message = e.stack.split('\n').filter(l => l).pop();

                        reject(e);
                    }
                });
            });

            await this.update(folks);
        } catch (e) {
            debug(e, 'Loading folks');
        }
    }
});


/**
 * The service class for this component
 */
var Service = Store;

