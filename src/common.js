/*
  Inspired by, but not derived from, the venerable 'convenience.js' which is:
  Copyright (c) 2011-2012, Giovanni Campagna <scampa.giovanni@gmail.com>
*/

const Lang = imports.lang;
const Format = imports.format
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;


/** Return an extension object for GJS apps not privy to Gnome Shell imports */
function getCurrentExtension() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let dir = Gio.File.new_for_path(m[1]).get_parent();
    
    let [s, meta, tag] = dir.get_child("metadata.json").load_contents(null);
    
    return {
        metadata: JSON.parse(meta),
        uuid: this.uuid,
        type: 2,
        dir: dir,
        path: dir.get_path(),
        error: "",
        hasPrefs: dir.get_child("prefs.js").query_exists(null)
    };
}

var Me = getCurrentExtension();

/** Init GSettings for Me.metadata['gschema-id'] */
let schemaSrc = Gio.SettingsSchemaSource.new_from_directory(
    Me.dir.get_child('schemas').get_path(),
    Gio.SettingsSchemaSource.get_default(),
    false
);

var Settings = new Gio.Settings({
    settings_schema: schemaSrc.lookup(Me.metadata['gschema-id'], true)
});
var Schema = Settings.settings_schema;

/** Init GResource for fallback icons */
var Resources = Gio.resource_load(Me.path + "/org.gnome.shell.extensions.gsconnect.gresource");
Resources._register();

//
var DBusInfo = {
    daemon: new Gio.DBusNodeInfo.new_for_xml(
        Resources.lookup_data(
            "/dbus/org.gnome.shell.extensions.gsconnect.daemon.xml", 0
        ).unref_to_array().toString()
    ),
    device: new Gio.DBusNodeInfo.new_for_xml(
        Resources.lookup_data(
            "/dbus/org.gnome.shell.extensions.gsconnect.device.xml", 0
        ).unref_to_array().toString()
    )
};

DBusInfo.daemon.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });
DBusInfo.device.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });

/** Initialize Gettext for metadata['gettext-domain'] */
function initTranslations() {
    Gettext.bindtextdomain(
        Me.metadata['gettext-domain'],
        Me.dir.get_child('locale').get_path()
    );
}

/**
 * Print a message to the log, prepended with the UUID of the extension
 * @param {String} msg - the message
 */
function log(msg) {
    global.log("[" + Me.metadata.uuid + "]: " + msg);
}

/**
 * Print a message to the log, prepended with the UUID of the extension and
 * "DEBUG".
 * @param {String} msg - the debugging message
 */
function debug(msg) {
    if (Settings.get_boolean("debug")) {
        log("DEBUG: " + msg);
    }
}


/**
 * Polyfills for older versions of GJS:
 *
 *     Object.assign()
 */
String.prototype.format = Format.format;

if (typeof Object.assign != "function") {
  // Must be writable: true, enumerable: false, configurable: true
  Object.defineProperty(Object, "assign", {
    value: function assign(target, varArgs) { // .length of function is 2
      'use strict';
      if (target == null) { // TypeError if undefined or null
        throw new TypeError("Cannot convert undefined or null to object");
      }

      var to = Object(target);

      for (var index = 1; index < arguments.length; index++) {
        var nextSource = arguments[index];

        if (nextSource != null) { // Skip over if undefined or null
          for (var nextKey in nextSource) {
            // Avoid bugs when hasOwnProperty is shadowed
            if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
              to[nextKey] = nextSource[nextKey];
            }
          }
        }
      }
      return to;
    },
    writable: true,
    configurable: true
  });
}

/** https://stackoverflow.com/a/37164538/1108697 */
function isObject(item) {
  return (item && typeof item === "object" && !Array.isArray(item));
}

function mergeDeep(target, source) {
  let output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target))
          Object.assign(output, { [key]: source[key] });
        else
          output[key] = mergeDeep(target[key], source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

