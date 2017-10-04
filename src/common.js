/*
  Inspired by, but not derived from, the venerable 'convenience.js' which is:
  Copyright (c) 2011-2012, Giovanni Campagna <scampa.giovanni@gmail.com>
*/

const Lang = imports.lang;
const Format = imports.format
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;


// Open the extension preferences window
function startPreferences() {
    try {
        GLib.spawn_command_line_async(
            "gnome-shell-extension-prefs gsconnect@andyholmes.github.io"
        );
    } catch (e) {
        log("Error spawning GSConnect settings: " + e);
    }
}


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

/** Initialize Gettext for metadata['gettext-domain'] */
function initTranslations() {
    Gettext.bindtextdomain(
        Me.metadata['gettext-domain'],
        Me.dir.get_child('locale').get_path()
    );
}

/**
 * Print a message to the log, prepended with the UUID of the extension, only
 * if the "debug" settings is enabled in GSettings.
 * @param {String} msg - the debugging message
 */
function debug(msg) {
    if (Settings.get_boolean("debug")) {
        log("[" + Me.metadata.uuid + "]: " + msg);
    }
}


/**
 *
 */
function get_fingerprint (pem) {
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


var CONFIG_PATH = GLib.get_user_config_dir() + "/gnome-shell-extension-gsconnect";


/**
 * Generate a Private/Public Key pair and TLS Certificate
 *
 * @param {Boolean} force - Force generation even if already created
 *
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


// FIXME
function installService (force=false) {
    let svc_dir = GLib.get_user_data_dir() + "/dbus-1/services";
    let svc_name = "/org.gnome.shell.extensions.gsconnect.daemon.service";
    
    if (!GLib.file_test(svc_dir + svc_name, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(svc_dir, 493);
    
        let svc_bytes = Resources.lookup_data(
            "/dbus" + svc_name, 0
        ).unref_to_array().toString();
        
        GLib.file_set_contents(svc_dir + svc_name, svc_bytes);
    }
        
    let app_dir = GLib.get_user_data_dir() + "/applications";
    let app_name = "/org.gnome.shell.extensions.gsconnect.daemon.desktop";
    
    if (!GLib.file_test(app_dir + app_name, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(app_dir, 493);
    
        let app_bytes = Resources.lookup_data(
            "/dbus" + app_name, 0
        ).unref_to_array().toString();
        
        GLib.file_set_contents(app_dir + app_name, app_bytes);
    }
};


function initConfiguration() {
    try {
        generateEncryption(false);
        installService(false);
    } catch (e) {
        log("Error initializing configuration: " + e);
        return false;
    }
    
    return true;
};


function readDeviceCache () {
    let config_dir = Gio.File.new_for_path(CONFIG_PATH);
    
    let fenum = config_dir.enumerate_children(
        "standard::name,standard::type,standard::size",
        Gio.FileQueryInfoFlags.NONE,
        null
    );
    
    let item, info;
    let devices = [];
    
    while ((info = fenum.next_file(null))) {
        let file = fenum.get_child(info);
        
        let identPath = file.get_path() + "/identity.json"
        
        if (GLib.file_test(identPath, GLib.FileTest.EXISTS)) {
            let [success, data] = GLib.file_get_contents(identPath);
            devices.push(JSON.parse(data));
        }
    }
    
    return devices;
};


function writeDeviceCache (daemon, deviceId=false) {
    if (deviceId) {
        log("updating cache for: " + deviceId);
        
        let devObjPath = "/org/gnome/shell/extensions/gsconnect/device/";
        let device = daemon._devices.get(devObjPath + deviceId);
        
        let deviceDir = CONFIG_PATH + "/" + deviceId;
        
        if (!GLib.file_test(deviceDir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(deviceDir, 493);
        }
        
        // Identity
        GLib.file_set_contents(
            deviceDir + "/identity.json",
            JSON.stringify(device.identity),
            JSON.stringify(device.identity).length,
            null
        );
    } else {
        for (let device of daemon._devices.values()) {
            writeDeviceCache(daemon, device.deviceId);
        }
    }
};


function readDeviceConfiguration (deviceId) {
    let config = {};
    let device_path = CONFIG_PATH + "/" + deviceId;
    let device_config = device_path + "/config.json";
    
    // Init Config Dir
    if (!GLib.file_test(device_path, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(device_path, 493);
    }
    
    // Load Config if it exists
    if (GLib.file_test(device_config, GLib.FileTest.EXISTS)) {
        try {
            config = JSON.parse(
                GLib.file_get_contents(device_config)[1].toString()
            );
        } catch (e) {
            log("Error loading device configuration: " + e);
            config = {};
        }
    }
    
    // Merge loaded config with defaults and save
    config = mergeDeep(DeviceDefaults, config)
    writeDeviceConfiguration(deviceId, config);
    
    return config;
};


// FIXME: error handling
function writeDeviceConfiguration (deviceId, config) {
    let device_config = CONFIG_PATH + "/" + deviceId + "/config.json";

    GLib.file_set_contents(
        device_config,
        JSON.stringify(config),
        JSON.stringify(config).length,
        null
    );
    
    return;
};


/**
 * Configuration Defaults
 *
 * TODO: this stuff should all be programmatic like KDE Connect
 */
var DeviceDefaults = {
    plugins: {
        battery: {
            enabled: false
        },
        clipboard: {
            enabled: false
        },
        findmyphone: {
            enabled: false
        },
        mousepad: {
            enabled: false
        },
        mpris: {
            enabled: false
        },
        notifications: {
            enabled: false,
            settings: {
                receive: {
                    enabled: true
                },
                send: {
                    enabled: true,
                    applications: {
                        GSConnect: {
                            iconName: "phone",
                            enabled: false
                        }
                    }
                }
            }
        },
        ping: {
            enabled: false
        },
        runcommand: {
            enabled: false,
            settings: {
                commands: {}
            }
        },
        sftp: {
            enabled: false,
            settings: {
                automount: false
            }
        },
        share: {
            enabled: false,
            settings: {
                download_directory: GLib.get_user_special_dir(
                    GLib.UserDirectory.DIRECTORY_DOWNLOAD
                ),
                download_subdirs: false
            }
        },
        telephony: {
            enabled: false,
            settings: {
                notify_missedCall: true,
                notify_ringing: true,
                notify_sms: true,
                autoreply_sms: false,
                notify_talking: true
            }
        }
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

