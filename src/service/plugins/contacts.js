'use strict';

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginBase = imports.service.plugin;
const Contacts = imports.service.components.contacts;

/*
 * We prefer libebook's vCard parser if it's available
 */
var EBookContacts;

try {
    EBookContacts = imports.gi.EBookContacts;
} catch (e) {
    EBookContacts = null;
}


var Metadata = {
    label: _('Contacts'),
    description: _('Access contacts of the paired device'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Contacts',
    incomingCapabilities: [
        'kdeconnect.contacts.response_uids_timestamps',
        'kdeconnect.contacts.response_vcards',
    ],
    outgoingCapabilities: [
        'kdeconnect.contacts.request_all_uids_timestamps',
        'kdeconnect.contacts.request_vcards_by_uid',
    ],
    actions: {},
};


/*
 * vCard 2.1 Patterns
 */
const VCARD_FOLDING = /\r\n |\r |\n |=\n/g;
const VCARD_SUPPORTED = /^fn|tel|photo|x-kdeconnect/i;
const VCARD_BASIC = /^([^:;]+):(.+)$/;
const VCARD_TYPED = /^([^:;]+);([^:]+):(.+)$/;
const VCARD_TYPED_KEY = /item\d{1,2}\./;
const VCARD_TYPED_META = /([a-z]+)=(.*)/i;


/**
 * Contacts Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/contacts
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectContactsPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'contacts');

        this._store = new Contacts.Store(device.id);
        this._store.fetch = this._requestUids.bind(this);

        // Notify when the store is ready
        this._contactsStoreReadyId = this._store.connect(
            'notify::context',
            () => this.device.notify('contacts')
        );

        // Notify if the contacts source changes
        this._contactsSourceChangedId = this.settings.connect(
            'changed::contacts-source',
            () => this.device.notify('contacts')
        );

        // Load the cache
        this._store.load();
    }

    clearCache() {
        this._store.clear();
    }

    connected() {
        super.connected();
        this._requestUids();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.contacts.response_uids_timestamps':
                this._handleUids(packet);
                break;

            case 'kdeconnect.contacts.response_vcards':
                this._handleVCards(packet);
                break;
        }
    }

    _handleUids(packet) {
        try {
            const contacts = this._store.contacts;
            const remote_uids = packet.body.uids;
            let removed = false;
            delete packet.body.uids;

            // Usually a failed request, so avoid wiping the cache
            if (remote_uids.length === 0)
                return;

            // Delete any contacts that were removed on the device
            for (let i = 0, len = contacts.length; i < len; i++) {
                const contact = contacts[i];

                if (!remote_uids.includes(contact.id)) {
                    this._store.remove(contact.id, false);
                    removed = true;
                }
            }

            // Build a list of new or updated contacts
            const uids = [];

            for (const [uid, timestamp] of Object.entries(packet.body)) {
                const contact = this._store.get_contact(uid);

                if (!contact || contact.timestamp !== timestamp)
                    uids.push(uid);
            }

            // Send a request for any new or updated contacts
            if (uids.length)
                this._requestVCards(uids);

            // If we removed any contacts, save the cache
            if (removed)
                this._store.save();
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Decode a string encoded as "QUOTED-PRINTABLE" and return a regular string
     *
     * See: https://github.com/mathiasbynens/quoted-printable/blob/master/src/quoted-printable.js
     *
     * @param {string} input - The QUOTED-PRINTABLE string
     * @return {string} The decoded string
     */
    _decodeQuotedPrintable(input) {
        return input
            // https://tools.ietf.org/html/rfc2045#section-6.7, rule 3
            .replace(/[\t\x20]$/gm, '')
            // Remove hard line breaks preceded by `=`
            .replace(/=(?:\r\n?|\n|$)/g, '')
            // https://tools.ietf.org/html/rfc2045#section-6.7, note 1.
            .replace(/=([a-fA-F0-9]{2})/g, ($0, $1) => {
                const codePoint = parseInt($1, 16);
                return String.fromCharCode(codePoint);
            });
    }

    /**
     * Decode a string encoded as "UTF-8" and return a regular string
     *
     * See: https://github.com/kvz/locutus/blob/master/src/php/xml/utf8_decode.js
     *
     * @param {string} input - The UTF-8 string
     * @return {string} The decoded string
     */
    _decodeUTF8(input) {
        try {
            const output = [];
            let i = 0;
            let c1 = 0;
            let seqlen = 0;

            while (i < input.length) {
                c1 = input.charCodeAt(i) & 0xFF;
                seqlen = 0;

                if (c1 <= 0xBF) {
                    c1 &= 0x7F;
                    seqlen = 1;
                } else if (c1 <= 0xDF) {
                    c1 &= 0x1F;
                    seqlen = 2;
                } else if (c1 <= 0xEF) {
                    c1 &= 0x0F;
                    seqlen = 3;
                } else {
                    c1 &= 0x07;
                    seqlen = 4;
                }

                for (let ai = 1; ai < seqlen; ++ai)
                    c1 = ((c1 << 0x06) | (input.charCodeAt(ai + i) & 0x3F));

                if (seqlen === 4) {
                    c1 -= 0x10000;
                    output.push(String.fromCharCode(0xD800 | ((c1 >> 10) & 0x3FF)));
                    output.push(String.fromCharCode(0xDC00 | (c1 & 0x3FF)));
                } else {
                    output.push(String.fromCharCode(c1));
                }

                i += seqlen;
            }

            return output.join('');

        // Fallback to old unfaithful
        } catch (e) {
            try {
                return decodeURIComponent(escape(input));

            // Say "chowdah" frenchie!
            } catch (e) {
                debug(e, `Failed to decode UTF-8 VCard field ${input}`);
                return input;
            }
        }
    }

    /**
     * Parse a vCard (v2.1 only) and return a dictionary of the fields
     *
     * See: http://jsfiddle.net/ARTsinn/P2t2P/
     *
     * @param {string} vcard_data - The raw VCard data
     * @return {Object} dictionary of vCard data
     */
    _parseVCard21(vcard_data) {
        // vcard skeleton
        const vcard = {
            fn: _('Unknown Contact'),
            tel: [],
        };

        // Remove line folding and split
        const unfolded = vcard_data.replace(VCARD_FOLDING, '');
        const lines = unfolded.split(/\r\n|\r|\n/);

        for (let i = 0, len = lines.length; i < len; i++) {
            const line = lines[i];
            let results, key, type, value;

            // Empty line or a property we aren't interested in
            if (!line || !line.match(VCARD_SUPPORTED))
                continue;

            // Basic Fields (fn, x-kdeconnect-timestamp, etc)
            if ((results = line.match(VCARD_BASIC))) {
                [, key, value] = results;
                vcard[key.toLowerCase()] = value;
                continue;
            }

            // Typed Fields (tel, adr, etc)
            if ((results = line.match(VCARD_TYPED))) {
                [, key, type, value] = results;
                key = key.replace(VCARD_TYPED_KEY, '').toLowerCase();
                value = value.split(';');
                type = type.split(';');

                // Type(s)
                const meta = {};

                for (let i = 0, len = type.length; i < len; i++) {
                    const res = type[i].match(VCARD_TYPED_META);

                    if (res)
                        meta[res[1]] = res[2];
                    else
                        meta[`type${i === 0 ? '' : i}`] = type[i].toLowerCase();
                }

                // Value(s)
                if (vcard[key] === undefined)
                    vcard[key] = [];

                // Decode QUOTABLE-PRINTABLE
                if (meta.ENCODING && meta.ENCODING === 'QUOTED-PRINTABLE') {
                    delete meta.ENCODING;
                    value = value.map(v => this._decodeQuotedPrintable(v));
                }

                // Decode UTF-8
                if (meta.CHARSET && meta.CHARSET === 'UTF-8') {
                    delete meta.CHARSET;
                    value = value.map(v => this._decodeUTF8(v));
                }

                // Special case for FN (full name)
                if (key === 'fn')
                    vcard[key] = value[0];
                else
                    vcard[key].push({meta: meta, value: value});
            }
        }

        return vcard;
    }

    /**
     * Parse a vCard (v2.1 only) using native JavaScript and add it to the
     * contact store.
     *
     * @param {string} uid - The contact UID
     * @param {string} vcard_data - The raw vCard data
     */
    async _parseVCardNative(uid, vcard_data) {
        try {
            const vcard = this._parseVCard21(vcard_data);

            const contact = {
                id: uid,
                name: vcard.fn,
                numbers: [],
                origin: 'device',
                timestamp: parseInt(vcard['x-kdeconnect-timestamp']),
            };

            // Phone Numbers
            contact.numbers = vcard.tel.map(entry => {
                let type = 'unknown';

                if (entry.meta && entry.meta.type)
                    type = entry.meta.type;

                return {type: type, value: entry.value[0]};
            });

            // Avatar
            if (vcard.photo) {
                const data = GLib.base64_decode(vcard.photo[0].value[0]);
                contact.avatar = await this._store.storeAvatar(data);
            }

            this._store.add(contact);
        } catch (e) {
            debug(e, `Failed to parse VCard contact ${uid}`);
        }
    }

    /**
     * Parse a vCard using libebook and add it to the contact store.
     *
     * @param {string} uid - The contact UID
     * @param {string} vcard_data - The raw vCard data
     */
    async _parseVCard(uid, vcard_data) {
        try {
            const contact = {
                id: uid,
                name: _('Unknown Contact'),
                numbers: [],
                origin: 'device',
                timestamp: 0,
            };

            const evcard = EBookContacts.VCard.new_from_string(vcard_data);
            const attrs = evcard.get_attributes();

            for (let i = 0, len = attrs.length; i < len; i++) {
                const attr = attrs[i];
                let data, number;

                switch (attr.get_name().toLowerCase()) {
                    case 'fn':
                        contact.name = attr.get_value();
                        break;

                    case 'tel':
                        number = {value: attr.get_value(), type: 'unknown'};

                        if (attr.has_type('CELL'))
                            number.type = 'cell';
                        else if (attr.has_type('HOME'))
                            number.type = 'home';
                        else if (attr.has_type('WORK'))
                            number.type = 'work';

                        contact.numbers.push(number);
                        break;

                    case 'x-kdeconnect-timestamp':
                        contact.timestamp = parseInt(attr.get_value());
                        break;

                    case 'photo':
                        data = GLib.base64_decode(attr.get_value());
                        contact.avatar = await this._store.storeAvatar(data);
                        break;
                }
            }

            this._store.add(contact);
        } catch (e) {
            debug(e, `Failed to parse VCard contact ${uid}`);
        }
    }

    /**
     * Handle an incoming list of contact vCards and pass them to the best
     * available parser.
     *
     * @param {Core.Packet} packet - A `kdeconnect.contacts.response_vcards`
     */
    _handleVCards(packet) {
        try {
            // We don't use this
            delete packet.body.uids;

            // Parse each vCard and add the contact
            for (const [uid, vcard] of Object.entries(packet.body)) {
                if (EBookContacts)
                    this._parseVCard(uid, vcard);
                else
                    this._parseVCardNative(uid, vcard);
            }
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /**
     * Request a list of contact UIDs with timestamps.
     */
    _requestUids() {
        this.device.sendPacket({
            type: 'kdeconnect.contacts.request_all_uids_timestamps',
        });
    }

    /**
     * Request the vCards for @uids.
     *
     * @param {string[]} uids - A list of contact UIDs
     */
    _requestVCards(uids) {
        this.device.sendPacket({
            type: 'kdeconnect.contacts.request_vcards_by_uid',
            body: {
                uids: uids,
            },
        });
    }

    destroy() {
        this._store.disconnect(this._contactsStoreReadyId);
        this.settings.disconnect(this._contactsSourceChangedId);

        super.destroy();
    }
});
