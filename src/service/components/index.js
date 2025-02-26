// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as atspi from './atspi.js';
import * as clipboard from './clipboard.js';
import * as contacts from './contacts.js';
import * as input from './input.js';
import * as mpris from './mpris.js';
import * as notification from './notification.js';
import * as pulseaudio from './pulseaudio.js';
import * as session from './session.js';
import * as sound from './sound.js';
import * as upower from './upower.js';
import * as ydotool from './ydotool.js';

export const functionOverrides = {};

const components = {
    atspi,
    clipboard,
    contacts,
    input,
    mpris,
    notification,
    pulseaudio,
    session,
    sound,
    upower,
    ydotool,
};

/*
 * Singleton Tracker
 */
const Default = new Map();


/**
 * Acquire a reference to a component. Calls to this function should always be
 * followed by a call to `release()`.
 *
 * @param {string} name - The module name
 * @returns {*} The default instance of a component
 */
export function acquire(name) {
    if (functionOverrides.acquire)
        return functionOverrides.acquire(name);

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
 * @returns {null} A %null value, useful for overriding a traced variable
 */
export function release(name) {
    if (functionOverrides.release)
        return functionOverrides.release(name);

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
