'use strict';

const Gtk = imports.gi.Gtk;


/**
 * TODO: required for GJS 1.52 (GNOME 3.28)
 */
Gtk.Widget.prototype.connectTemplate = function() {
    this.$templateHandlers = [];

    Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
        this.$templateHandlers.push([
            obj,
            obj.connect(signalName, this[handlerName].bind(this))
        ]);
    });
};

Gtk.Widget.prototype.disconnectTemplate = function() {
    Gtk.Widget.set_connect_func.call(this, function() {});
    this.$templateHandlers.map(([obj, id]) => obj.disconnect(id));
};

