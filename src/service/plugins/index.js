// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


// Load all plugins using dynamic import
const plugins = {};

const dir = Gio.File.new_for_uri(import.meta.url).get_parent();
const iter = await dir.enumerate_children_async(
    Gio.FILE_ATTRIBUTE_STANDARD_NAME,
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    GLib.PRIORITY_DEFAULT,
    null);
const infos = await iter.next_files_async(100, GLib.PRIORITY_DEFAULT, null);
iter.close_async(GLib.PRIORITY_DEFAULT, null, null);

for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    const name = info.get_name().replace(/\.js$/, '');
    if (name === 'index')
        continue;
    plugins[name] = await import(`./${name}.js`);
}

export default plugins;
