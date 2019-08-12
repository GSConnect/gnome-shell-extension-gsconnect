'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
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
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Contacts',
    incomingCapabilities: [
        'kdeconnect.contacts.response_uids_timestamps',
        'kdeconnect.contacts.response_vcards'
    ],
    outgoingCapabilities: [
        'kdeconnect.contacts.request_all_uids_timestamps',
        'kdeconnect.contacts.request_vcards_by_uid'
    ],
    actions: {}
};


/**
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
    GTypeName: 'GSConnectContactsPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'contacts');
        this._store = new Contacts.Store(device.id);

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

        // Prepare the store
        this._store.prepare();
    }

    connected() {
        super.connected();
        this.requestUids();
    }

    cacheClear() {
        this._store.clear();
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.contacts.response_uids_timestamps') {
            this._handleUids(packet);
        } else if (packet.type === 'kdeconnect.contacts.response_vcards') {
            this._handleVCards(packet);
        }
    }

    _handleUids(packet) {
        try {
            let contacts = this._store.contacts;
            let remote_uids = packet.body.uids;
            let removed = false;
            delete packet.body.uids;

            // Usually a failed request, so avoid wiping the cache
            if (remote_uids.length === 0) return;

            // Delete any contacts that were removed on the device
            for (let i = 0, len = contacts.length; i < len; i++) {
                let contact = contacts[i];

                if (!remote_uids.includes(contact.id)) {
                    this._store.remove(contact.id, false);
                    removed = true;
                }
            }

            if (removed) this._store.__cache_write();

            // Build a list of new or updated contacts
            let uids = [];

            for (let [uid, timestamp] of Object.entries(packet.body)) {
                let contact = this._store.get_contact(uid);

                if (!contact || contact.timestamp !== timestamp) {
                    uids.push(uid);
                }
            }

            // Send a request for any new or updated contacts
            if (uids.length) {
                this.requestVCards(uids);
            }
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
     * @return {string} - The decoded string
     */
    decode_quoted_printable(input) {
        return input
            // https://tools.ietf.org/html/rfc2045#section-6.7, rule 3
            .replace(/[\t\x20]$/gm, '')
            // Remove hard line breaks preceded by `=`
            .replace(/=(?:\r\n?|\n|$)/g, '')
            // https://tools.ietf.org/html/rfc2045#section-6.7, note 1.
            .replace(/=([a-fA-F0-9]{2})/g, ($0, $1) => {
                let codePoint = parseInt($1, 16);
                return String.fromCharCode(codePoint);
            });
    }

    /**
     * Decode a string encoded as "UTF-8" and return a regular string
     *
     * See: https://github.com/kvz/locutus/blob/master/src/php/xml/utf8_decode.js
     * 
     * @param {string} input - The UTF-8 string
     * @return {string} - The decoded string
     */
    decode_utf8(input) {
        try {
            let output = [];
            let i = 0;
            let c1 = 0;
            let seqlen = 0;

            while (i < input.length) {
                c1 = input.charCodeAt(i) & 0xFF;
                seqlen = 0;

                if (c1 <= 0xBF) {
                    c1 = (c1 & 0x7F);
                    seqlen = 1;
                } else if (c1 <= 0xDF) {
                    c1 = (c1 & 0x1F);
                    seqlen = 2;
                } else if (c1 <= 0xEF) {
                    c1 = (c1 & 0x0F);
                    seqlen = 3;
                } else {
                    c1 = (c1 & 0x07);
                    seqlen = 4;
                }

                for (let ai = 1; ai < seqlen; ++ai) {
                    c1 = ((c1 << 0x06) | (input.charCodeAt(ai + i) & 0x3F));
                }

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
                warning(`Failed to decode UTF-8 VCard field "${input}"`);
                return input;
            }
        }
    }

    /**
     * Parse a VCard v2.1 and return a dictionary of data
     *
     * See: http://jsfiddle.net/ARTsinn/P2t2P/
     *
     * @param {string} vcard_data - The raw VCard data
     */
    parseVCard21(vcard_data) {
        // vcard skeleton
        let vcard = {
            fn: _('Unknown Contact'),
            tel: []
        };

        // Remove line folding and split
        let lines = vcard_data.replace(VCARD_FOLDING, '').split(/\r\n|\r|\n/);

        for (let i = 0, len = lines.length; i < len; i++) {
            let line = lines[i];
            let results, key, type, value;

            // Empty line or a property we aren't interested in
            if (!line || !line.match(VCARD_SUPPORTED)) continue;

            // Basic Fields (fn, x-kdeconnect-timestamp, etc)
            if ((results = line.match(VCARD_BASIC))) {
                [results, key, value] = results;
                vcard[key.toLowerCase()] = value;
                continue;
            }

            // Typed Fields (tel, adr, etc)
            if ((results = line.match(VCARD_TYPED))) {
                [results, key, type, value] = results;
                key = key.replace(VCARD_TYPED_KEY, '').toLowerCase();
                value = value.split(';');
                type = type.split(';');

                // Type(s)
                let meta = {};

                for (let i = 0, len = type.length; i < len; i++) {
                    let res = type[i].match(VCARD_TYPED_META);

                    if (res) {
                        meta[res[1]] = res[2];
                    } else {
                        meta['type' + (i === 0 ? '' : i)] = type[i].toLowerCase();
                    }
                }

                // Value(s)
                if (vcard[key] === undefined) vcard[key] = [];

                // Decode QUOTABLE-PRINTABLE
                if (meta.ENCODING && meta.ENCODING === 'QUOTED-PRINTABLE') {
                    delete meta.ENCODING;
                    value = value.map(v => this.decode_quoted_printable(v));
                }

                // Decode UTF-8
                if (meta.CHARSET && meta.CHARSET === 'UTF-8') {
                    delete meta.CHARSET;
                    value = value.map(v => this.decode_utf8(v));
                }

                // Special case for FN (full name)
                if (key === 'fn') {
                    vcard[key] = value[0];
                } else {
                    vcard[key].push({meta: meta, value: value});
                }
            }
        }

        return vcard;
    }

    async parseVCardNative(uid, vcard_data) {
        try {
            let vcard = this.parseVCard21(vcard_data);

            let contact = {
                id: uid,
                name: vcard.fn,
                numbers: [],
                origin: 'device',
                timestamp: parseInt(vcard['x-kdeconnect-timestamp'])
            };

            // Phone Numbers
            contact.numbers = vcard.tel.map(entry => {
                let type = 'unknown';

                if (entry.meta && entry.meta.type) {
                    type = entry.meta.type;
                }

                return {type: type, value: entry.value[0]};
            });

            // Avatar
            if (vcard.photo) {
                let data = GLib.base64_decode(vcard.photo[0].value[0]);
                contact.avatar = await this._store.storeAvatar(data);
            }

            return contact;
        } catch (e) {
            warning(e, `Failed to parse VCard contact "${uid}"`);
            return undefined;
        }
    }
    
    async parseVCard(uid, vcard_data) {
        try {
            let contact = {
                id: uid,
                name: _('Unknown Contact'),
                numbers: [],
                origin: 'device',
                timestamp: 0
            };
            
            let evcard = EBookContacts.VCard.new_from_string(vcard_data);
            let evattrs = evcard.get_attributes();
            
            for (let i = 0, len = evattrs.length; i < len; i++) {
                let attr = evattrs[i];
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
                        
                        contact.numbers.push (number);
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

            return contact;
        } catch (e) {
            warning(e, `Failed to parse VCard contact "${uid}"`);
            return undefined;
        }
    }

    async _handleVCards(packet) {
        try {
            // We don't use this
            delete packet.body.uids;

            // Parse each vCard and add the contact
            for (let [uid, vcard] of Object.entries(packet.body)) {
                let contact;
                
                if (EBookContacts) {
                    contact = await this.parseVCard(uid, vcard);
                } else {
                    contact = await this.parseVCardNative(uid, vcard);
                }

                if (contact) {
                    this._store.add(contact);
                }
            }
        } catch (e) {
            logError(e);
        }
    }

    requestUids() {
        this.device.sendPacket({
            type: 'kdeconnect.contacts.request_all_uids_timestamps'
        });
    }

    requestVCards(uids) {
        this.device.sendPacket({
            type: 'kdeconnect.contacts.request_vcards_by_uid',
            body: {
                uids: uids
            }
        });
    }

    destroy() {
        this.settings.disconnect(this._contactsStoreReadyId);
        this.settings.disconnect(this._contactsSourceChangedId);
        super.destroy();
    }
});

