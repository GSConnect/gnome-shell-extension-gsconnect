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
        'path': GObject.ParamSpec.string(
            'path',
            'Path',
            'Cache path, relative to gsconnect.cachedir',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'provider-icon': GObject.ParamSpec.string(
            'provider-icon',
            'ContactsProvider',
            'The contact provider icon name',
            GObject.ParamFlags.READWRITE,
            ''
        )
    }
}, class Store extends GObject.Object {

    _init(params) {
        super._init(Object.assign({
            path: 'folks'
        }, params));

        // Asynchronous setup
        this._init_async();
    }

    async _init_async() {
        try {
            this._contacts = await JSON.load(this.__cache_file);
        } catch (e) {
            this._contacts = {};
            logWarning(e);
        } finally {
            this.connect('notify::contacts', this.__cache_write.bind(this));
            this._loadFolks();
        }
    }

    async __cache_write() {
        try {
            if (this.__cache_lock) {
                this.__cache_queue = true;
                return;
            }

            this.__cache_lock = true;
            await JSON.dump(this._contacts, this.__cache_file);
        } catch (e) {
            logWarning(e, 'Contacts.Store.__cache_write()');
        } finally {
            this.__cache_lock = false;

            if (this.__cache_queue) {
                this.__cache_queue = false;
                this.__cache_write();
            }
        }
    }

    *[Symbol.iterator]() {
        for (let contact of Object.values(this._contacts)) {
            yield contact;
        }
    }

    get path() {
        return this._path;
    }

    set path(path) {
        this._path = GLib.build_filenamev([gsconnect.cachedir, path]);
        GLib.mkdir_with_parents(this._path, 448);

        this.__cache_file = Gio.File.new_for_path(
            GLib.build_filenamev([this._path, 'contacts.json'])
        );
    }

    get provider_icon() {
        if (this._provider_icon === undefined) {
            this._provider_icon = 'call-start-symbolic';
        }

        return this._provider_icon;
    }

    set provider_icon(icon_name) {
        this._provider_icon = icon_name;
        this.notify('provider-icon');
    }

    /**
     * Set a contact avatar from a base64 encoded JPEG ByteArray
     *
     * @param {object} id - The contact id
     * @param {ByteArray} contents - A base64 encoded JPEG ByteArray
     * @return {object} - The updated contact
     */
    setAvatarContents(id, contents) {
        return new Promise((resolve, reject) => {
            let contact = this._contacts[id];

            if (contact.avatar) {
                resolve(contact);
            } else {
                let path = GLib.build_filenamev([this._path, `${id}.jpeg`]);

                Gio.File.new_for_path(path).replace_contents_bytes_async(
                    new GLib.Bytes(contents),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (file, res) => {
                        try {
                            file.replace_contents_finish(res);
                            this._contacts[id].avatar = path;
                            this.notify('contacts');
                            resolve(this._contacts[id]);
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
        return new Promise((resolve, reject) => {
            let contact = this._contacts[id];

            if (contact) {
                this._contacts[id].avatar = path;
                this.notify('contacts');
                resolve(this._contacts[id]);
            } else {
                reject(new Error('no such contact'));
            }
        });
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {Object} query - A query object
     * @param {String} [query.name] - The contact's name
     * @param {String} [query.number] - The contact's number
     * @param {Boolean} [query.create] - Save the contact if it's new
     */
    query(query) {
        let matches = [];
        let number = (query.number) ? query.number.toPhoneNumber() : null;

        for (let contact of Object.values(this._contacts)) {
            // Prioritize searching by number
            if (number) {
                for (let num of contact.numbers) {
                    let cnumber = num.value.toPhoneNumber();

                    if (number.endsWith(cnumber) || cnumber.endsWith(number)) {
                        // Number match & exact name match; must be it
                        if (query.name && query.name === contact.name) {
                            return contact;
                        }

                        matches.push(contact);
                    }
                }

            // Fallback to searching by exact name match
            } else if (query.name && query.name === contact.name) {
                matches.push(contact);
            }
        }

        // Create a new contact
        // TODO: use folks to add contact
        if (matches.length === 0) {
            // Create a unique ID for this contact
            let id = GLib.uuid_string_random();
            while (this._contacts.hasOwnProperty(id)) {
                id = GLib.uuid_string_random();
            }

            // Populate a dummy contact
            matches[0] = {
                id: id,
                name: query.name || query.number,
                numbers: [{ value: query.number, type: 'unknown' }],
                origin: 'gsconnect'
            };

            // Save if requested
            if (query.create) {
                this._contacts[id] = matches[0];
                this.notify('contacts');
            }
        }

        // Only return the first match (pretty much what Android does)
        return matches[0];
    }

    // FIXME: API compatible with GListModel
    get_item(position) {
        try {
            return (this._contacts[position]) ? this._contacts[position] : null;
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
        switch (false) {
            case (contact.id):
            case (contact.name):
            case (contact.numbers):
            case (contact.numbers[0]):
            case (contact.numbers[0].type):
            case (contact.numbers[0].value):
                return;

            // New contact
            case (this._contacts[contact.id]):
                this._contacts[contact.id] = contact;
                break;

            // Updated contact
            default:
                Object.assign(this._contacts[contact.id], contact);
        }

        this.notify('contacts');
    }

    /**
     * Remove a contact by id
     *
     * @param {string} id - The id of the contact to delete
     */
    remove(id) {
        if (this._contacts[id]) {
            delete this._contacts[id];
            this.notify('contacts');
        }
    }

    clear() {
        try {
            this._contacts = {};
            this.notify('contacts');
        } catch (e) {
            logError(e);
        }
    }

    async update(json) {
        try {
            this._contacts = Object.assign(this._contacts, json);

            this._provider_icon = 'x-office-address-book-symbolic.symbolic';
            this.notify('provider-icon');
            this.notify('contacts');
        } catch (e) {
            logError(e);
        }
    }

    async _loadFolks() {
        try {
            let folks = await new Promise((resolve, reject) => {
                let launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                });

                launcher.setenv('FOLKS_BACKENDS_DISABLED', 'telepathy', true);

                let proc = launcher.spawnv([
                    gsconnect.extdatadir + '/service/components/folks.py'
                ]);

                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);

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
            logWarning(e, 'Contacts.Store._loadFolks()');
        }
    }
});


/**
 * The service class for this component
 */
var Service = Store;

