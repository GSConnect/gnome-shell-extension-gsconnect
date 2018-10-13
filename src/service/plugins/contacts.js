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
            // We don't use this
            delete packet.body.uids;

            let uids = [];

            for (let [uid, timestamp] of Object.entries(packet.body)) {
                let cache = this._store.get_item(uid);

                if (!cache || cache.timestamp !== timestamp) {
                    uids.push(uid);
                }
            }

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
     * @param {string} input - The UTF-8 string
     * @return {string} - The decoded string
     */
	decode_utf8(input) {
	    return decodeURIComponent(escape(input));
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

            // Static Keys (fn, x-kdeconnect-timestamp, etc)
            results = line.match(VCARD_REGEX_META);

            if (results) {
                [results, key, value] = results;
                vcard[key.toLowerCase()] = value;
                return;
            }

            // Typed Keys (tel, adr, etc)
            results = line.match(VCARD_REGEX_PROP);

            if (results) {
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
                if (meta.ENCODING === 'QUOTED-PRINTABLE') {
                    delete meta.ENCODING;
                    value = value.map(v => this.decode_quoted_printable(v));
                }

                if (meta.ENCODING === 'UTF-8') {
                    delete meta.ENCODING;
                    value = value.map(v => this.decode_utf8(v));
                }

                vcard[key].push({ meta: meta, value: value });
            }
        });

        return vcard;
	}

    async parseContact(uid, vcard_data) {
        try {
            let vcard = this.parseVCard(vcard_data);

            let contact = {
                id: uid,
                name: Array.isArray(vcard.fn) ? vcard.fn[0].value : vcard.fn,
                numbers: [],
                origin: 'device',
                timestamp: parseInt(vcard['x-kdeconnect-timestamp'])
            };

            // Phone Numbers
            if (vcard.tel) {
                vcard.tel.map(number => {
                    contact.numbers.push({
                        type: (number.meta) ? number.meta.type : 'unknown',
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
            debug(e);
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

