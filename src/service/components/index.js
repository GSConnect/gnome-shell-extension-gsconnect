// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/*
 * Singleton Tracker
 */
const Default = new Map();

// Load all components using dynamic import
const components = {};

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
    components[name] = await import(`./${name}.js`);
}

/**
 * Acquire a reference to a component. Calls to this function should always be
 * followed by a call to `release()`.
 *
 * @param {string} name - The module name
 * @return {*} The default instance of a component
 */
export function acquire(name) {
    let component;

    try {
        let info = Default.get(name);

        if (info === undefined) {
            const module = components[name];

            info = {
                instance: new module.default(),
                refcount: 0,
            };

            Default.set(name, info);
        }

        info.refcount++;
        component = info.instance;
    } catch (e) {
        debug(e, name);
    }

    return component;
}


/**
 * Release a reference on a component. If the caller was the last reference
 * holder, the component will be freed.
 *
 * @param {string} name - The module name
 * @return {null} A %null value, useful for overriding a traced variable
 */
export function release(name) {
    try {
        const info = Default.get(name);

        if (info.refcount === 1) {
            info.instance.destroy();
            Default.delete(name);
        }

        info.refcount--;
    } catch (e) {
        debug(e, name);
    }

    return null;
}

