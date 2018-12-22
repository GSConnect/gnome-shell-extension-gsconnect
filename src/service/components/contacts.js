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
        'contacts': GObject.param_spec_variant(
            'contacts',
            'ContactsList',
            'A list of cached contacts',
            new GLib.VariantType('a{sv}'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'context': GObject.ParamSpec.string(
            'context',
            'Context',
            'Used as the cache directory, relative to gsconnect.cachedir',
            GObject.ParamFlags.READWRITE,
            ''
        )
    }
}, class Store extends GObject.Object {

    _init(params) {
        super._init(Object.assign({
            context: null
        }, params));

        this.__cache_data = {};

        // Asynchronous setup
        this._init_async();
    }

    async _init_async() {
        try {
            this.__cache_data = await JSON.load(this.__cache_file);
        } catch (e) {
            warning(e);
            this.__cache_data = {};
        } finally {
            this.connect('notify::contacts', this.__cache_write.bind(this));

            if (this.context === null) {
                // Create a re-usable launcher for folks.py
                this._launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                });
                this._launcher.setenv('FOLKS_BACKENDS_DISABLED', 'telepathy', true);

                this._loadFolks();
            }
        }
    }

    async __cache_write() {
        try {
            if (this.__cache_lock) {
                this.__cache_queue = true;
                return;
            }

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
        for (let contact of Object.values(this.__cache_data)) {
            yield contact;
        }
    }

    get context() {
        return this._context || null;
    }

    set context(context) {
        if (!context) {
            this._context = null;
            this.__cache_dir = Gio.File.new_for_path(gsconnect.cachedir);
        } else {
            this._context = context;
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
     * @return {string} - Path the the avatar file
     */
    setAvatarContents(contents) {
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
                            reject(e);
                        }
                    }
                );
            }
        });
    }

    /**
     * Set a contact avatar from a file path
     *
     * @param {object} id - The contact id
     * @param {string} contents - A file path to a GdkPixbuf compatible image
     * @return {object} - The updated contact
     */
    setAvatarPath(id, path) {
        let contact = this.__cache_data[id];

        if (contact) {
            this.__cache_data[id].avatar = path;
            this.update();
            return this.__cache_data[id];
        }
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {Object} query - A query object
     * @param {String} [query.name] - The contact's name
     * @param {String} query.number - The contact's number
     */
    query(query) {
        // sanity check
        if (!query.number) {
            throw new Error('query.number is undefined');
        }

        // First look for an existing contact by number
        let contacts = Object.values(this.__cache_data);
        let matches = [];
        let qnumber = query.number.toPhoneNumber();

        for (let i = 0; i < contacts.length; i++) {
            let contact = contacts[i];

            for (let num of contact.numbers) {
                let cnumber = num.value.toPhoneNumber();

                if (qnumber.endsWith(cnumber) || cnumber.endsWith(qnumber)) {
                    // Number match & exact name match; must be it
                    if (query.name && query.name === contact.name) {
                        return contact;
                    }

                    // Hold off on returning; we might find an exact name match
                    matches.push(contact);
                }
            }
        }

        // Return the first match (pretty much what Android does)
        if (matches.length > 0) {
            // TODO: this is a check to prevent errors later caused by contacts
            // that may have be populated without names by GSConnect <= v17
            if (!matches[0].name) {
                matches[0].name = query.number;
            }

            return matches[0];
        }

        // No match; create a new contact with a unique ID
        let id = GLib.uuid_string_random();
        while (this.__cache_data.hasOwnProperty(id)) {
            id = GLib.uuid_string_random();
        }

        // Add the contact to the cache
        this.__cache_data[id] = {
            id: id,
            name: query.name || query.number,
            numbers: [{value: query.number, type: 'unknown'}],
            origin: 'gsconnect'
        };

        this.update();

        // Return the created contact
        return this.__cache_data[id];
    }

    // FIXME: API compatible with GListModel
    get_item(position) {
        try {
            return (this.__cache_data[position]) ? this.__cache_data[position] : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Add a contact, checking for validity
     *
     * @param {string} id - The id of the contact to delete
     */
    add(contact) {
        switch (true) {
            case !contact.id:
            case !contact.name:
            case !contact.numbers:
            case !contact.numbers[0]:
            case !contact.numbers[0].type:
            case !contact.numbers[0].value:
                return;

            // Updated contact
            case this.__cache_data.hasOwnProperty(contact.id):
                Object.assign(this.__cache_data[contact.id], contact);
                break;

            // New contact
            default:
                this.__cache_data[contact.id] = contact;
        }

        this.update();
    }

    /**
     * Remove a contact by id
     *
     * @param {string} id - The id of the contact to delete
     */
    remove(id) {
        if (this.__cache_data[id]) {
            delete this.__cache_data[id];
            this.update();
        }
    }

    clear(only_temp = false) {
        try {
            if (only_temp) {
                for (let contact of Object.values(this.__cache_data)) {
                    if (contact.origin === 'gsconnect') {
                        delete this.__cache_data[contact.id];
                    }
                }
            } else {
                this.__cache_data = {};
            }

            this.update();
        } catch (e) {
            logError(e);
        }
    }

    update(json = {}) {
        try {
            this.__cache_data = Object.assign(this.__cache_data, json);
            this.notify('contacts');
        } catch (e) {
            logError(e);
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

            this.update(folks);
        } catch (e) {
            warning(e);
        }
    }
});


/**
 * The service class for this component
 */
var Service = Store;

