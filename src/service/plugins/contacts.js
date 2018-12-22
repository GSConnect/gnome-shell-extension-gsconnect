'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const Contacts = imports.service.components.contacts;


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
const VCARD_REGEX_META = /^(version|fn|title|org|X-KDECONNECT-TIMESTAMP):(.+)$/i;
const VCARD_REGEX_PROP = /^([^:;]+);([^:]+):(.+)$/;
const VCARD_REGEX_KEY = /item\d{1,2}\./;


/**
 * Contacts Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/contacts
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectContactsPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'contacts');

        this._store = new Contacts.Store({
            context: device.id
        });
    }

    connected() {
        super.connected();
        this.requestUids();
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
            // Delete any contacts that were removed on the device
            let remote_removed = false;
            let remote_uids = packet.body.uids;
            delete packet.body.uids;

            for (let contact of this._store) {
                // Skip contacts that were added from a different source
                if (contact.origin !== 'device') continue;

                if (!remote_uids.includes(contact.id)) {
                    delete this._store.__cache_data[contact.id];
                    remote_removed = true;
                }
            }

            // If any contacts were deleted, signal an update
            if (remote_removed) {
                this._store.update();
            }

            // Build a list of new or updated contacts
            let uids = [];

            for (let [uid, timestamp] of Object.entries(packet.body)) {
                let cache = this._store.get_item(uid);

                if (!cache || cache.timestamp !== timestamp) {
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
    parseVCard(vcard_data) {
        //
        let vcard = {};

        // Remove line wrapping
        vcard_data = vcard_data.replace(/\n /g, '');

        vcard_data.split('\n').forEach(line => {
            let results, key, type, value;

            // Simple Keys (fn, x-kdeconnect-timestamp, etc)
            if ((results = line.match(VCARD_REGEX_META))) {
                [results, key, value] = results;
                vcard[key.toLowerCase()] = value;
                return;
            }

            // Typed Keys (tel, adr, etc)
            if ((results = line.match(VCARD_REGEX_PROP))) {
                [results, key, type, value] = results;
                key = key.replace(VCARD_REGEX_KEY, '').toLowerCase();
                value = value.split(';');

                let meta = {};

                type.split(';').map((p, i) => {
                    let res = p.match(/([a-z]+)=(.*)/i);

                    if (res) {
                        meta[res[1]] = res[2];
                    } else {
                        meta['type' + (i === 0 ? '' : i)] = p.toLowerCase();
                    }
                });

                //
                if (!vcard[key]) vcard[key] = [];

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

                if (key === 'fn') {
                    vcard[key] = value[0];
                } else {
                    vcard[key].push({meta: meta, value: value});
                }
            }
        });

        return vcard;
    }

    async parseContact(uid, vcard_data) {
        try {
            let vcard = this.parseVCard(vcard_data);

            let contact = {
                id: uid,
                name: vcard.fn || _('Unknown Contact'),
                numbers: [],
                origin: 'device',
                timestamp: parseInt(vcard['x-kdeconnect-timestamp'])
            };

            // Phone Numbers
            if (vcard.tel) {
                vcard.tel.map(number => {
                    let type = 'unknown';
                    
                    if (number.meta && number.meta.type) {
                        type = number.meta.type;
                    }
                    
                    contact.numbers.push({
                        type: type,
                        value: number.value[0]
                    });
                });
            }

            // Avatar
            if (vcard.photo) {
                let data = GLib.base64_decode(vcard.photo[0].value[0]);
                contact.avatar = await this._store.setAvatarContents(data);
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

            // Parse each VCard and return a contact object
            let contacts = {};

            for (let [uid, vcard] of Object.entries(packet.body)) {
                let contact = await this.parseContact(uid, vcard);

                if (contact) {
                    contacts[uid] = contact;
                }
            }

            this._store.update(contacts);
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
});

