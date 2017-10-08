/*
  Inspired by, but not derived from, the venerable 'convenience.js' which is:
  Copyright (c) 2011-2012, Giovanni Campagna <scampa.giovanni@gmail.com>
*/

const Lang = imports.lang;
const Format = imports.format
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
 * Kill the service daemon
 */
function stopService () {
    try {
        GLib.spawn_command_line_async(
            "bash -c \"kill $(ps aux | grep 'gsconnect@andyholmes.github.io/service/[d]aemon.js' | awk '{print $2}')\""
        );
    } catch (e) {
        log("Error stopping GSConnect service: " + e);
    }
};


/**
 * Return an extension object for GJS apps not privy to Gnome Shell imports
 */
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

/**
 * Some useful constants
 */
var Me = getCurrentExtension();
var CONFIG_PATH = GLib.get_user_config_dir() + "/gnome-shell-extension-gsconnect";


/**
 * Init GSettings
 */
let schemaSrc = Gio.SettingsSchemaSource.new_from_directory(
    Me.dir.get_child('schemas').get_path(),
    Gio.SettingsSchemaSource.get_default(),
    false
);

var Settings = new Gio.Settings({
    settings_schema: schemaSrc.lookup(Me.metadata['app-id'], true)
});
var Schema = Settings.settings_schema;


/**
 * Initialize Gettext for metadata['gettext-domain']
 */
function initTranslations() {
    Gettext.bindtextdomain(
        Me.metadata['extension-id'],
        Me.dir.get_child('locale').get_path()
    );
}

/** Init GResource for fallback icons */
var Resources = Gio.resource_load(Me.path + "/org.gnome.shell.extensions.gsconnect.gresource");
Resources._register();


/**
 * Common DBus Interface Nodes/Proxies and functions
 */
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
    ),
    freedesktop: new Gio.DBusNodeInfo.new_for_xml(
        Resources.lookup_data(
            "/dbus/org.freedesktop.Notifications.xml", 0
        ).unref_to_array().toString()
    )
};

DBusInfo.daemon.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });
DBusInfo.device.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });
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
    )
};


function dbusPathFromId (id) {
    let basePath = "/org/gnome/shell/extensions/gsconnect/device/";
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
        log("[" + Me.metadata.uuid + "]: " + msg);
    }
}


/**
 * Generate a Private/Public Key pair and TLS Certificate
 *
 * @param {Boolean} force - Force generation even if already created
 */
function generateEncryption (force=false) {
    if (!GLib.file_test(CONFIG_PATH, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(CONFIG_PATH, 493);
    }
    
    let hasPrivateKey = GLib.file_test(
        CONFIG_PATH + "/private.pem",
        GLib.FileTest.EXISTS
    );
    
    let hasCertificate = GLib.file_test(
        CONFIG_PATH + "/certificate.pem",
        GLib.FileTest.EXISTS
    );
    
    if (force || (!hasPrivateKey || !hasCertificate)) {
        let cmd = [
            "openssl", "req", "-new", "-x509", "-sha256", "-newkey",
            "rsa:2048", "-nodes", "-keyout", "private.pem", "-days", "3650",
            "-out", "certificate.pem", "-subj",
            "/CN=" + GLib.uuid_string_random()
        ];
        
        let [res, stdout, stderr, exit_status] = GLib.spawn_sync(
            CONFIG_PATH,
            cmd,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    }
    
    GLib.spawn_command_line_async("chmod 0600 " + CONFIG_PATH + "/private.pem");
    GLib.spawn_command_line_async("chmod 0600 " + CONFIG_PATH + "/certificate.pem");
};


/**
 * Get a SHA1 fingerprint for a TLS Certificate
 *
 * @param {string} pem - A TLS Certificate in PEM format
 * @return {string} - A SHA1 fingerprint
 */
function getFingerprint (pem) {
    let args = ["openssl", "x509", "-noout", "-fingerprint", "-sha1", "-inform", "pem"];
    
    let proc = GLib.spawn_async_with_pipes(
        null,                                   // working dir
        args,                                   // argv
        null,                                   // envp
        GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
        null                                    // child_setup (func)
    );
    
    let stdin = new Gio.DataOutputStream({
        base_stream: new Gio.UnixOutputStream({ fd: proc[2] })
    });
    stdin.put_string(pem, null);
    stdin.close(null);
    
    let stdout = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: proc[3] })
    });
    let fingerprint = stdout.read_line(null)[0].toString().split("=")[1];
    stdout.close(null);
    
    return fingerprint;
};


function installService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services";
    let serviceFile = "/org.gnome.shell.extensions.gsconnect.daemon.service";
    
    if (!GLib.file_test(serviceDir + serviceFile, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(serviceDir, 493);
    
        let serviceBytes = Resources.lookup_data(
            "/dbus" + serviceFile, 0
        ).unref_to_array().toString();
        
        GLib.file_set_contents(serviceDir + serviceFile, serviceBytes);
    }
    
    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications";
    let appFile = "/org.gnome.shell.extensions.gsconnect.daemon.desktop";
    
    if (!GLib.file_test(appDir + appFile, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(appDir, 493);
    
        let appBytes = Resources.lookup_data(
            "/dbus" + appFile, 0
        ).unref_to_array().toString();
        
        GLib.file_set_contents(appDir + appFile, appBytes);
    }
};


function initConfiguration () {
    try {
        generateEncryption(false);
        installService();
        initTranslations();
        Gtk.IconTheme.get_default().add_resource_path("/icons");
    } catch (e) {
        log("Error initializing configuration: " + e);
        return false;
    }
    
    return true;
};


function uninitConfiguration () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services";
    let serviceFile = "/org.gnome.shell.extensions.gsconnect.daemon.service";
    GLib.unlink(serviceDir + serviceFile);
    
    // Application desktop file
    let appDir = GLib.get_user_data_dir() + "/applications";
    let appFile = "/org.gnome.shell.extensions.gsconnect.daemon.desktop";
    GLib.unlink(appDir + appFile);
};


function findPlugins () {
    let pluginDir = Gio.File.new_for_path(getPath() + "/service/plugins");
    let fenum = pluginDir.enumerate_children("standard::*", 0, null);

    let info;
    let plugins = [];

    while ((info = fenum.next_file(null))) {
        let file = fenum.get_child(info);
        let name = file.get_basename().slice(0, -3);
        
        if (imports.service.plugins[name].hasOwnProperty("METADATA")) {
            plugins.push(imports.service.plugins[name].METADATA.name);
        }
    }
    
    return plugins.sort();
};


function readDeviceConfiguration (deviceId) {
    let config = {};
    let devicePath = CONFIG_PATH + "/" + deviceId;
    let deviceConfig = devicePath + "/config.json";
    
    // Init Config Dir
    if (!GLib.file_test(devicePath, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(devicePath, 493);
    }
    
    // Load Config if it exists
    if (GLib.file_test(deviceConfig, GLib.FileTest.EXISTS)) {
        try {
            config = JSON.parse(
                GLib.file_get_contents(deviceConfig)[1].toString()
            );
        } catch (e) {
            log("Error loading device configuration: " + e);
            config = {};
        }
    }
    
    // Create a default config
    let defaultConfiguration = { plugins: {} };
    
    for (let name of findPlugins()) {
        let metadata = imports.service.plugins[name].METADATA;
        
        defaultConfiguration.plugins[name] = { enabled: false };
        
        if (metadata.hasOwnProperty("settings")) {
            defaultConfiguration.plugins[name].settings = metadata.settings;
        }
    }
    
    // Merge loaded config with defaults and save
    config = mergeDeep(defaultConfiguration, config)
    writeDeviceConfiguration(deviceId, config);
    
    return config;
};


function writeDeviceConfiguration (deviceId, config) {
    let deviceConfig = CONFIG_PATH + "/" + deviceId + "/config.json";

    try {
        GLib.file_set_contents(
            deviceConfig,
            JSON.stringify(config),
            JSON.stringify(config).length,
            null
        );
    } catch (e) {
        log("Error saving device configuration: " + e);
    }
};


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

