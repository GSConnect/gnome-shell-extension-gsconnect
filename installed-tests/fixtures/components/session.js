'use strict';


var Component = class MockSession {
    get idle() {
        if (this._idle === undefined)
            this._idle = false;

        return this._idle;
    }

    get locked() {
        if (this._locked === undefined)
            this._locked = false;

        return this._locked;
    }

    get active() {
        // Active if not idle and not locked
        return !(this.idle || this.locked);
    }

    /**
     * Update the session with an object of properties and values.
     *
     * @param {Object} obj - A dictionary of properties
     */
    update(obj) {
        for (const [propertyName, propertyValue] of Object.entries(obj))
            this[`_${propertyName}`] = propertyValue;
    }
};

