"use strict";

// Imports
const Lang = imports.lang;
const Format = imports.format;
const Gettext = imports.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

var APP_ID = "org.gnome.Shell.Extensions.GSConnect";
var PREFIX = getPath();
var METADATA = JSON.parse(GLib.file_get_contents(PREFIX + "/metadata.json")[1]);
var CACHE_DIR = GLib.get_user_cache_dir() + "/gsconnect";
var CONFIG_DIR = GLib.get_user_config_dir() + "/gsconnect";
var RUNTIME_DIR = GLib.get_user_runtime_dir() + "/gsconnect";

for (let path of [CACHE_DIR, CONFIG_DIR, RUNTIME_DIR]) {
    GLib.mkdir_with_parents(path, 448);
}


/**
 * Open the extension preferences window
 */
function startPreferences () {
    try {
        GLib.spawn_command_line_async(
            "gnome-shell-extension-prefs gsconnect@andyholmes.github.io"
        );
    } catch (e) {
        log("Error spawning GSConnect settings: " + e);
    }
};


/**
 * Init GSettings
 */
var SchemaSource = Gio.SettingsSchemaSource.new_from_directory(
    PREFIX + "/schemas",
    Gio.SettingsSchemaSource.get_default(),
    false
);

var Settings = new Gio.Settings({
    settings_schema: SchemaSource.lookup(APP_ID, true)
});


/**
 * Init GResources
 */
var Resources = Gio.resource_load(PREFIX + "/" + APP_ID + ".data.gresource");
Resources._register();


/**
 * Common DBus Interface Nodes, Proxies and functions
 */
var DBusIface = new Gio.DBusNodeInfo.new_for_xml(
    Resources.lookup_data("/dbus/" + APP_ID + ".xml", 0).toArray().toString()
);

DBusIface.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });


function dbusPathFromId (id) {
    let basePath = "/org/gnome/Shell/Extensions/GSConnect/Device/";
    let dbusPath = basePath + id.replace(/\W+/g, "_");

    return dbusPath;
};


/**
 * If "debug" is enabled in GSettings, Print a message to the log, prepended
 * with the UUID of the extension.
 * @param {String} msg - the debugging message
 */
function debug(msg) {
    if (Settings.get_boolean("debug")) {
        log("[" + METADATA.uuid + "]: " + msg);
    }
}


/**
 * Check if a command is in the PATH
 * @param {string} name - the name of the command
 */
function checkCommand (name) {
    let proc = GLib.spawn_async_with_pipes(
        null,                           // working dir
        ["which", name],                // argv
        null,                           // envp
        GLib.SpawnFlags.SEARCH_PATH,    // enables PATH
        null                            // child_setup (func)
    );

    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let [result, length] = stdout.read_line(null);
    stdout.close(null);

    return (result !== null);
};


/**
 * Return whether the local devices is a laptop or desktop
 */
function getDeviceType () {
    let proc = GLib.spawn_async_with_pipes(
        null,                                       // working dir
        ["cat", "/sys/class/dmi/id/chassis_type"],  // argv
        null,                                       // envp
        GLib.SpawnFlags.SEARCH_PATH,                // enables PATH
        null                                        // child_setup (func)
    );

    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let chassisInt = stdout.read_line(null)[0].toString();
    stdout.close(null);

    if (["8", "9", "10", "14"].indexOf(chassisInt) > -1) {
        return "laptop";
    } else {
        return "desktop";
    }
};


/**
 * Generate a Private Key and TLS Certificate
 */
function generateEncryption () {
    let hasPrivateKey = GLib.file_test(
        CONFIG_DIR + "/private.pem",
        GLib.FileTest.EXISTS
    );

    let hasCertificate = GLib.file_test(
        CONFIG_DIR + "/certificate.pem",
        GLib.FileTest.EXISTS
    );

    if (!hasPrivateKey || !hasCertificate) {
        let cmd = [
            "openssl", "req", "-new", "-x509", "-sha256", "-newkey",
            "rsa:2048", "-nodes", "-keyout", "private.pem", "-days", "3650",
            "-out", "certificate.pem", "-subj",
            "/CN=" + GLib.uuid_string_random()
        ];

        let proc = GLib.spawn_sync(
            CONFIG_DIR,
            cmd,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    }

    // Ensure permissions are restrictive
    GLib.spawn_command_line_async("chmod 0600 " + CONFIG_DIR + "/private.pem");
    GLib.spawn_command_line_async("chmod 0600 " + CONFIG_DIR + "/certificate.pem");
};


/**
 * Return a Gio.TlsCertificate object, for @id if given, or false if none
 *
 * @param {string} [id] - A device Id
 */
function getCertificate (id=false) {
    if (id) {
        let settings = new Gio.Settings({
            settings_schema: SchemaSource.lookup(APP_ID + ".Device", true),
            path: "/org/gnome/shell/extensions/gsconnect/device/" + id + "/"
        });

        if (settings.get_string("certificate-pem")) {
            return Gio.TlsCertificate.new_from_pem(
                settings.get_string("certificate-pem"),
                -1
            );
        }
    } else {
        return Gio.TlsCertificate.new_from_files(
            CONFIG_DIR + "/certificate.pem",
            CONFIG_DIR + "/private.pem"
        );
    }

    return false;
};


/**
 * Install/Uninstall a .desktop file and DBus service file for GSConnect
 */
function installService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    let serviceFile = APP_ID + ".service";
    let serviceBytes = Resources.lookup_data(
        "/dbus/" + serviceFile, 0
    ).toArray().toString().replace("@PREFIX@", PREFIX);

    GLib.mkdir_with_parents(serviceDir, 493);
    GLib.file_set_contents(serviceDir + serviceFile, serviceBytes);

    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications/";
    let appFile = APP_ID + ".desktop";
    let appBytes = Resources.lookup_data(
        "/dbus/" + appFile, 0
    ).toArray().toString().replace("@PREFIX@", PREFIX);

    GLib.mkdir_with_parents(appDir, 493);
    GLib.file_set_contents(appDir + appFile, appBytes);
};


function uninstallService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    GLib.unlink(serviceDir + APP_ID + ".service");

    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications/";
    GLib.unlink(appDir + APP_ID + ".desktop");
};


/**
 * Init the configuration
 */
function initConfiguration () {
    try {
        generateEncryption();
        installService();
        Gettext.bindtextdomain(APP_ID, PREFIX + "/locale");
        );
        Gtk.IconTheme.get_default().add_resource_path("/icons");
    } catch (e) {
        log("Error initializing configuration: " + e);
        return false;
    }

    return true;
};


/**
 * Extend Gio.TlsCertificate with a function to retreive the Common Name
 *
 * @return {string} - The common name of the certificate issuer
 */
Gio.TlsCertificate.prototype.get_common_name = function () {
    let proc = GLib.spawn_async_with_pipes(
        null,
        ["openssl", "x509", "-noout", "-subject", "-inform", "pem"],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null
    );

    let stdin = new Gio.DataOutputStream({
        base_stream: new Gio.UnixOutputStream({ fd: proc[2] })
    });
    stdin.put_string(this.certificate_pem, null);
    stdin.close(null);

    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let uuid = stdout.read_line(null)[0].toString().split("/CN=")[1];
    stdout.close(null);

    return uuid;
};


/**
 * Extend Gio.TlsCertificate with a SHA1 fingerprint function
 * See: https://bugzilla.gnome.org/show_bug.cgi?id=788315
 *
 * @return {string} - A SHA1 fingerprint
 */
Gio.TlsCertificate.prototype.fingerprint = function () {
    let proc = GLib.spawn_async_with_pipes(
        null,
        ["openssl", "x509", "-noout", "-fingerprint", "-sha1", "-inform", "pem"],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null
    );

    let stdin = new Gio.DataOutputStream({
        base_stream: new Gio.UnixOutputStream({ fd: proc[2] })
    });
    stdin.put_string(this.certificate_pem, null);
    stdin.close(null);

    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let fingerprint = stdout.read_line(null)[0].toString().split("=")[1];
    stdout.close(null);

    return fingerprint;
};


/**
 * String.format API supporting %s, %d, %x and %f
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = Format.format;


/**
 * A rarely repeating array shuffler
 * See: https://stackoverflow.com/a/17891411/1108697
 */
Object.defineProperty(Array, "shuffler", {
    value: function (array) {
        "use strict";
        if (!array) { array = this; }
        var copy = array.slice(0);
        return function () {
            if (copy.length < 1) { copy = array.slice(0); }
            var index = Math.floor(Math.random() * copy.length);
            var item = copy[index];
            copy.splice(index, 1);
            return item;
        };
    },
    writable: true,
    configurable: true
});


/**
 * Object.assign() Polyfill
 */
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

/**
 * Number.isInteger() Polyfill
 */
Number.isInteger = Number.isInteger || function(value) {
  return typeof value === 'number' &&
    isFinite(value) &&
    Math.floor(value) === value;
};

