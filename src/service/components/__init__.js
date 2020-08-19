'use strict';


/*
 * Singleton Tracker
 */
const Default = new Map();


/**
 * Acquire a reference to a component. Calls to this function should always be
 * followed by a call to `release()`.
 *
 * @param {string} name - The module name
 * @return {*} The default instance of a component
 */
function acquire(name) {
    let component;

    try {
        let info = Default.get(name);

        if (info === undefined) {
            let module = imports.service.components[name];

            info = {
                instance: new module.Component(),
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
function release(name) {
    try {
        let info = Default.get(name);

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

