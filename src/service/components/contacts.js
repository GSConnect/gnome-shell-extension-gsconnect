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
     * Get Gdk.Pixbuf for @path, allowing for the corrupt JPEG's KDE Connect
     * sometimes sends. This function must be synchronous since it is used in
     * Contacts.Avatar::draw and Promises have a higher priority in the loop.
     *
     * @param {string} path - A local file path
     */
    getPixbuf(path, size=null) {
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

        if (size !== null) {
            return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
        }

        return pixbuf;
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

    async remove(query) {
        if (typeof query === 'object') {
            for (let [id, contact] of Object.entries(this._contacts)) {
                if (query === contact) {
                    delete this._contacts[id];
                    this.notify('contacts');
                    break;
                }
            }
        } else {
            delete this._contacts[query];
            this.notify('contacts');
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

