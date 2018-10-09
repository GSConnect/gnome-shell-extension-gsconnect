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
            context: null
        }, params));

        // Asynchronous setup
        this._init_async();
    }

    async _init_async() {
        try {
            this.__cache_data = await JSON.load(this.__cache_file);
        } catch (e) {
            logWarning(e);
            this.__cache_data = {};
        } finally {
            this.connect('notify::contacts', this.__cache_write.bind(this));

            if (this.context === null) {
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
            logWarning(e);
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

    get provider_icon() {
        if (!this._provider_icon) {
            this._provider_icon = 'call-start-symbolic';
        }

        return this._provider_icon;
    }

    set provider_icon(icon_name) {
        this._provider_icon = icon_name;
        this.notify('provider-icon');
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
     * @param {String} [query.number] - The contact's number
     * @param {Boolean} [query.create] - Save the contact if it's new
     */
    query(query) {
        let matches = [];
        let number = (query.number) ? query.number.toPhoneNumber() : null;

        for (let contact of Object.values(this.__cache_data)) {
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
        if (matches.length === 0) {
            // Create a unique ID for this contact
            let id = GLib.uuid_string_random();
            while (this.__cache_data.hasOwnProperty(id)) {
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
                this.__cache_data[id] = matches[0];
                this.update();
            }
        }

        // Only return the first match (pretty much what Android does)
        return matches[0];
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

    clear() {
        try {
            this.__cache_data = {};
        this.update();
        } catch (e) {
            logError(e);
        }
    }

    update(json={}) {
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

            this._provider_icon = 'x-office-address-book-symbolic.symbolic';
            this.notify('provider-icon');

            this.update(folks);
        } catch (e) {
            logWarning(e);
        }
    }
});


/**
 * The service class for this component
 */
var Service = Store;

