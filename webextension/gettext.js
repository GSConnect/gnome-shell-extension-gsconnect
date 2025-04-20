#!/usr/bin/env -S gjs -m

// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const _ = (msgid) => GLib.dgettext('org.gnome.Shell.Extensions.GSConnect', msgid);

// POT Patterns
const MSGID_REGEX = /^msgid "(.+)"$/;
const MSGSTR_REGEX = /^msgstr "(.+)"$/;

// MSGID -> MESSAGE Reverse Map
const MSGID = {
    'GSConnect': 'extensionName',
    'Share links with GSConnect, direct to the browser or by SMS.': 'extensionDescription',
    'Send To Mobile Device': 'contextMenuMultipleDevices',
    'Service Unavailable': 'popupMenuDisconnected',
    'No Device Found': 'popupMenuNoDevices',
    'Open in Browser': 'shareMessage',
    'Send SMS': 'smsMessage',
};


// TRANSLATORS: Extension name
_('GSConnect');
// TRANSLATORS: Chrome/Firefox WebExtension description
_('Share links with GSConnect, direct to the browser or by SMS.');
// TRANSLATORS: Top-level context menu item for GSConnect
_('Send To Mobile Device');
// TRANSLATORS: WebExtension can't connect to GSConnect
_('Service Unavailable');
// TRANSLATORS: No devices are known or available
_('No Device Found');
// TRANSLATORS: Open URL with the device's browser
_('Open in Browser');
// TRANSLATORS: Share URL by SMS
_('Send SMS');

//
JSON.load = function (gfile) {
    try {
        const data = gfile.load_contents(null)[1];

        if (data instanceof Uint8Array)
            return JSON.parse(new TextDecoder().decode(data));
        else
            return JSON.parse(data.toString());
    } catch (e) {
        logError(e);
        return {};
    }
};

// Find the cwd, locale dir and po dir
const cwd = Gio.File.new_for_path('.');
const localedir = cwd.get_child('_locales');
const podir = cwd.get_parent().get_child('po');

// Load the english translation as a template
let template = localedir.get_child('en').get_child('messages.json');
template = JSON.load(template);

//

let info;
const iter = podir.enumerate_children('standard::name', 0, null);

while ((info = iter.next_file(null))) {
    const [lang, ext] = info.get_name().split('.');

    // Only process PO files
    if (ext !== 'po')
        continue;

    /**
     * Convert glibc language codes
     *
     * pt_BR => pt-BR
     * sr@latin => sr-Latn
     */
    let langCode = lang.replace('_', '-');
    langCode = langCode.replace('@latin', '-Latn');

    console.log(`Processing ${lang} as ${langCode}`);

    // Make a new dir and file
    const jsondir = localedir.get_child(langCode);
    const jsonfile = jsondir.get_child('messages.json');
    GLib.mkdir_with_parents(jsondir.get_path(), 448);

    // If the translation exists, update the template with its messages
    let json = JSON.parse(JSON.stringify(template));

    if (jsonfile.query_exists(null))
        json = Object.assign(json, JSON.load(jsonfile));

    // Read the PO file and search the msgid's for our strings
    let msgid = false;
    let po = iter.get_child(info).load_contents(null)[1];
    po = new TextDecoder().decode(po);

    for (const line of po.split('\n')) {
        // If we have a msgid, we're expecting a msgstr
        if (msgid) {
            if (MSGSTR_REGEX.test(line))
                json[msgid]['message'] = line.match(MSGSTR_REGEX)[1];

            msgid = false;

        // Otherwise set msgid to a mapped message
        } else if (MSGID_REGEX.test(line)) {
            msgid = MSGID[line.match(MSGID_REGEX)[1]];
        }
    }

    // Write the (updated) translation
    json = `${JSON.stringify(json, null, 4)}\n\n`;
    jsonfile.replace_contents(json, null, false, 0, null);
}
