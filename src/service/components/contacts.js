'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


//
var CACHE_DIR = GLib.build_filenamev([gsconnect.cachedir, '_contacts']);


function mergeContacts(current, update) {
    let newContacts = {};

    for (let id in update) {
        let updateContact = update[id];

        if (current.hasOwnProperty(id)) {
            // FIXME: deep merge
            newContacts[id] = Object.assign(current[id], update[id]);
        } else {
            newContacts[id] = update[id];
        }

//        // Update contact
//        if (current.hasOwnProperty(id)) {
//            ['name', 'origin', 'avatar', 'folk_id'].forEach(prop => {
//                current[id][prop] = update[id][prop] || current[id][prop];
//            });

//            for (let entry of updateContact.numbers) {
//                let found = false;

//                for (let centry of current[id].numbers) {
//                    if (entry.number === centry.number) {
//                        ['type', 'uri'].forEach(prop => {
//                            centry[prop] = entry[prop] || centry[prop];
//                        });
//                        found = true;
//                        break;
//                    }
//                }

//                if (!found) {
//                    current[id].numbers.push(entry);
//                }
//            }
//        // New contact
//        } else {
//            current[id] = update[id];
//        }
    }

    return newContacts;
};


var Store = GObject.registerClass({
    GTypeName: 'GSConnectContactsStore',
    Properties: {
        'contacts': GObject.param_spec_variant(
            'contacts',
            'ContactsList',
            'A list of cached contacts',
            new GLib.VariantType('as'),
            new GLib.Variant('as', []),
            GObject.ParamFlags.READABLE
        ),
        'provider-icon': GObject.ParamSpec.string(
            'provider-icon',
            'ContactsProvider',
            'The contact provider icon name',
            GObject.ParamFlags.READABLE,
            ''
        )
    }
}, class Store extends GObject.Object {

    _init() {
        super._init();

        // Init cache
        GLib.mkdir_with_parents(CACHE_DIR, 448);

        this._cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([CACHE_DIR, 'contacts.json'])
        );

        // Asynchronous setup
        this._init_async();
    }

    async _init_async() {
        try {
            // Load the cache
            this._cacheFile.load_contents_async(null, (file, res) => {
                try {
                    let contents = file.load_contents_finish(res)[1];
                    this._contacts = JSON.parse(contents);
                } catch (e) {
                    this._contacts = {};
                } finally {
                    this.connect('notify::contacts', this._writeCache.bind(this));
                    this.update();
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    get contacts() {
        return Object.keys(this._contacts);
    }

    get provider_icon() {
        if (this._provider_icon === undefined) {
            return 'call-start-symbolic';
        }

        return this._provider_icon;
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
     * Set Gdk.Pixbuf for @contact
     *
     * @param {object} contact - A contact dictionary object
     * @param {string} contents - The contents of the pixbuf
     */
    setPixbuf(contact, contents) {
        return new Promise((resolve, reject) => {
            if (contact.avatar) {
                resolve(contact);
            } else {
                let path = GLib.build_filenamev([
                    CACHE_DIR,
                    GLib.uuid_string_random() + '.jpeg'
                ]);

                let file = Gio.File.new_for_path(path);

                file.replace_contents_async(
                    contents,
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (file, res) => {
                        try {
                            file.replace_contents_finish(res);
                            contact.avatar = path;
                            resolve(contact);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );

                this.notify('contacts');
            }
        });
    }

    /**
     * Query the Store for a contact by name and/or number.
     *
     * @param {Object} query - A query object
     * @param {String} [query.name] - The contact's name
     * @param {String} [query.number] - The contact's number
     * @param {Boolean} [query.single] - Only return if there is a single match
     * @param {Boolean} [query.create] - Create and return a new contact if none
     */
    query(query) {
        let number = (query.number) ? query.number.replace(/\D/g, '') : null;

        let matches = {};

        for (let id in this._contacts) {
            let contact = this._contacts[id];

            // Prioritize searching by number
            if (number) {
                for (let num of contact.numbers) {
                    // Match by number stripped of non-digits
                    if (number === num.number.replace(/\D/g, '')) {
                        matches[id] = contact;

                        // Number match & exact name match; must be it
                        if (query.name && query.name === contact.name) {
                            return contact;
                        }
                    }
                }
            // Fallback to searching by exact name match
            } else if (query.name && query.name === contact.name) {
                matches[id] = contact;
            }
        }

        //
        let keys = Object.keys(matches);

        // Create a new contact
        // TODO: use folks to add contact
        if (keys.length === 0 && query.create) {
            // Create a unique ID for this contact
            let id = GLib.uuid_string_random();
            while (this._contacts.hasOwnProperty(id)) {
                id = GLib.uuid_string_random();
            }

            // Add the contact & save to cache
            this._contacts[id] = {
                name: query.name || query.number,
                numbers: [{ number: query.number, type: 'unknown' }],
                origin: 'gsconnect'
            };
            this.notify('contacts');

            matches[id] = this._contacts[id];
            keys = Object.keys(matches);
        }

        // Check for a single match
        if (query.single) {
            if (keys.length === 1) {
                return matches[keys[0]];
            }

            return false;
        }

        return matches;
    }

    async remove(query) {
        if (typeof query === 'object') {
            for (let [id, contact] of Object.entries(this._contacts)) {
                if (query === contact) {
                    delete this._contacts[id];
                    break;
                }
            }
        } else {
            delete this._contacts[query];
        }

        this.notify('contacts');
    }

    async update() {
        let result = 'call-start-symbolic';

        try {
            result = await this._updateFolksContacts();
        } catch (e) {
            Gio.Application.get_default().send_error(e, 'folks-error');
        } finally {
            this._provider_icon = result;
            this.notify('provider-icon');
            this.notify('contacts');
        }
    }

    _updateFolksContacts() {
        return new Promise((resolve, reject) => {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });

            launcher.setenv('FOLKS_BACKENDS_DISABLED', 'telepathy', true);

            let proc = launcher.spawnv([
                'python3',
                gsconnect.extdatadir + '/service/components/folks.py'
            ]);

            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);

                    if (stderr.length > 0) {
                        throw new Error(stderr)
                    }

                    let folks = JSON.parse(stdout);
                    this._contacts = mergeContacts(this._contacts, folks);
                    resolve('gnome-contacts-symbolic');
                } catch (e) {
                    // format python errors
                    e.stack = e.message;
                    e.message = e.stack.split('\n').filter(l => l).pop();
                    reject(e);
                }
            });
        });
    }

    _writeCache() {
        this._cacheFile.replace_contents_async(
            JSON.stringify(this._contacts),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );
    }
});


/**
 * The service class for this component
 */
var Service = Store;

