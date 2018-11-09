#!/usr/bin/env gjs

'use strict';

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
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
    'Send SMS': 'smsMessage'
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
        let data = gfile.load_contents(null)[1];

        if (data instanceof Uint8Array) {
            return JSON.parse(ByteArray.toString(data));
        } else {
            return JSON.parse(data.toString());
        }
    } catch (e) {
        logError(e);
        return {};
    }
};

// Find the cwd, locale dir and po dir
let cwd = Gio.File.new_for_path('.');
let localedir = cwd.get_child('_locales');
let podir = cwd.get_parent().get_child('po');

// Load the english translation as a template
let template = localedir.get_child('en').get_child('messages.json');
template = JSON.load(template);

//

let info, iter = podir.enumerate_children('standard::name', 0, null);

while ((info = iter.next_file(null))) {
    let [lang, ext] = info.get_name().split('.');

    if (ext !== 'po') {
        continue;
    }

    print(`Processing "${lang}"`);

    // Make a new dir and file
    let jsondir = localedir.get_child(lang);
    let jsonfile = jsondir.get_child('messages.json');
    GLib.mkdir_with_parents(jsondir.get_path(), 448);

    // If the translation exists, update the template with its messages
    let json = JSON.parse(JSON.stringify(template));

    if (jsonfile.query_exists(null)) {
        json = Object.assign(json, JSON.load(jsonfile));
    }

    // Read the PO file and search the msgid's for our strings
    let msgid = false;
    let po = iter.get_child(info).load_contents(null)[1];
    po = (po instanceof Uint8Array) ? ByteArray.toString(po) : po.toString();

    for (let line of po.split('\n')) {
        // If we have a msgid, we're expecting a msgstr
        if (msgid) {
            if (MSGSTR_REGEX.test(line)) {
                json[msgid]['message'] = line.match(MSGSTR_REGEX)[1];
            }

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

