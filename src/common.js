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

imports.searchPath.push(getPath());

var PREFIX = getPath();
var METADATA = JSON.parse(GLib.file_get_contents(PREFIX + "/metadata.json")[1]);
var CACHE_DIR = GLib.get_user_cache_dir() + "/gsconnect";
var CONFIG_DIR = GLib.get_user_config_dir() + "/gsconnect";
var RUNTIME_DIR = GLib.get_user_runtime_dir() + "/gsconnect";

for (let path of [CACHE_DIR, CONFIG_DIR, RUNTIME_DIR]) {
    GLib.mkdir_with_parents(path, 493);
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
    settings_schema: SchemaSource.lookup(
        "org.gnome.shell.extensions.gsconnect",
        true
    )
});


/**
 * Init GResources
 */
var Resources = Gio.resource_load(
    PREFIX + "/org.gnome.Shell.Extensions.GSConnect.data.gresource"
);
Resources._register();


/**
 * Common DBus Interface Nodes, Proxies and functions
 */
var DBusInfo = {
    GSConnect: new Gio.DBusNodeInfo.new_for_xml(
        Resources.lookup_data(
            "/dbus/org.gnome.Shell.Extensions.GSConnect.xml", 0
        ).unref_to_array().toString()
    ),
    freedesktop: new Gio.DBusNodeInfo.new_for_xml(
        Resources.lookup_data(
            "/dbus/org.freedesktop.Notifications.xml", 0
        ).unref_to_array().toString()
    )
};

DBusInfo.GSConnect.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });
DBusInfo.freedesktop.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });


var DBusProxy = {
    mpris: new Gio.DBusProxy.makeProxyWrapper(
        Resources.lookup_data(
            "/dbus/org.mpris.MediaPlayer2.xml", 0
        ).unref_to_array().toString()
    ),
    mprisPlayer: new Gio.DBusProxy.makeProxyWrapper(
        Resources.lookup_data(
            "/dbus/org.mpris.MediaPlayer2.Player.xml", 0
        ).unref_to_array().toString()
    ),
    screensaver: new Gio.DBusProxy.makeProxyWrapper(
        Resources.lookup_data(
            "/dbus/org.gnome.ScreenSaver.xml", 0
        ).unref_to_array().toString()
    )
};


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
            settings_schema: SchemaSource.lookup(
                "org.gnome.shell.extensions.gsconnect.device",
                true
            ),
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
 * Install a .desktop file and DBus service file for GSConnect
 */
function installService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    let serviceFile = "org.gnome.Shell.Extensions.GSConnect.service";

    if (!GLib.file_test(serviceDir + serviceFile, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(serviceDir, 493);

        let serviceBytes = Resources.lookup_data(
            "/dbus/" + serviceFile, 0
        ).unref_to_array().toString();

        GLib.file_set_contents(serviceDir + serviceFile, serviceBytes);
    }

    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications/";
    let appFile = "org.gnome.Shell.Extensions.GSConnect.desktop";

    if (!GLib.file_test(appDir + appFile, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(appDir, 493);

        let appBytes = Resources.lookup_data(
            "/dbus/" + appFile, 0
        ).unref_to_array().toString();

        GLib.file_set_contents(appDir + appFile, appBytes);
    }
};


/**
 * Uninstall the .desktop file and DBus service file
 */
function uninstallService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    let serviceFile = "org.gnome.Shell.Extensions.GSConnect.service";
    GLib.unlink(serviceDir + serviceFile);

    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications/";
    let appFile = "org.gnome.Shell.Extensions.GSConnect.desktop";
    GLib.unlink(appDir + appFile);
};


/**
 * Install/Uninstall WebExtension Native Messaging Host
 */
function installNativeMessagingHost () {
    let nmhPath = PREFIX + "/service/nativeMessagingHost.js";

    let google = {
        "name": "org.gnome.shell.extensions.gsconnect",
        "description": "Native messaging host for GSConnect WebExtension",
        "path": nmhPath,
        "type": "stdio",
        "allowed_origins": [ "chrome-extension://jfnifeihccihocjbfcfhicmmgpjicaec/" ]
    };

    let mozilla = {
        "name": "org.gnome.shell.extensions.gsconnect",
        "description": "Native messaging host for GSConnect WebExtension",
        "path": nmhPath,
        "type": "stdio",
        "allowed_extensions": [ "gsconnect@andyholmes.github.io" ]
    };

    let basename = "org.gnome.shell.extensions.gsconnect.json";
    let browsers = [
        [GLib.get_user_config_dir() + "/chromium/NativeMessagingHosts/", google],
        [GLib.get_user_config_dir() + "/google-chrome/NativeMessagingHosts/", google],
        [GLib.get_home_dir() + "/.mozilla/native-messaging-hosts/", mozilla]
    ];

    for (let browser of browsers) {
        if (!GLib.file_test(browser[0] + basename, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(browser[0], 493);
            GLib.file_set_contents(
                browser[0] + basename,
                JSON.stringify(browser[1])
            );
        }
    }

    GLib.spawn_command_line_async("chmod 0755 " + nmhPath);
};


function uninstallNativeMessagingHost () {
    let basename = "org.gnome.shell.extensions.gsconnect.json";
    let browsers = [
        GLib.get_user_config_dir() + "/chromium/NativeMessagingHosts/",
        GLib.get_user_config_dir() + "/google-chrome/NativeMessagingHosts/",
        GLib.get_home_dir() + "/.mozilla/native-messaging-hosts/"
    ];

    for (let browser of browsers) {
        if (GLib.file_test(browser + basename, GLib.FileTest.EXISTS)) {
            GLib.unlink(browser + basename);
        }
    }

    let nmhPath = PREFIX + "/service/nativeMessagingHost.js";
    GLib.spawn_command_line_async("chmod 0744 " + nmhPath);
};


/**
 * Init the configuration
 */
function initConfiguration () {
    try {
        generateEncryption();
        installService();
        Gettext.bindtextdomain(
            "org.gnome.Shell.Extensions.GSConnect",
            PREFIX + "/locale"
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

