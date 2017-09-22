"use strict";

const Lang = imports.lang;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;


var CONFIG_PATH = GLib.get_user_config_dir() + "/gnome-shell-extension-gsconnect";


/**
 * Generate a Private/Public Key pair and TLS Certificate
 *
 * @param {Boolean} force - Force generation even if already created
 */
function generate_encryption (force=false) {
    if (!GLib.file_test(CONFIG_PATH, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(CONFIG_PATH, 493);
    }
    
    let hasPrivateKey = GLib.file_test(
        CONFIG_PATH + "/private.pem",
        GLib.FileTest.EXISTS
    );
    
//    let hasPublicKey = GLib.file_test(
//        CONFIG_PATH + "/public.pem",
//        GLib.FileTest.EXISTS
//    );
    
    let hasCertificate = GLib.file_test(
        CONFIG_PATH + "/certificate.pem",
        GLib.FileTest.EXISTS
    );
    
    if (force || (!hasPrivateKey || !hasCertificate)) {
        let cmd = [
            "openssl", "req", "-new", "-x509", "-sha256", "-newkey",
            "rsa:2048", "-nodes", "-keyout", "private.pem", "-days", "3650",
            "-out", "certificate.pem", "-subj",
            "/O=KDE/OU=KDE Connect/CN=_e6e29ad4_2b31_4b6d_8f7a_9872dbaa9095_" // FIXME: uuid
        ];
        
        let [res, stdout, stderr, exit_status] = GLib.spawn_sync(
            CONFIG_PATH, // working dir
            cmd, // argv
            null, // envp
            GLib.SpawnFlags.SEARCH_PATH, // flags,
            null // child_setup
        );
        
//        [res, stdout, stderr, exit_status] = GLib.spawn_sync(
//            CONFIG_PATH, // working dir
//            ["openssl", "rsa", "-in", "private.pem", "-pubout", "-out", "public.pem"], // argv
//            null, // envp
//            GLib.SpawnFlags.SEARCH_PATH, // flags,
//            null // child_setup
//        );
    }
};


function read_daemon_config(daemon) {
    let config = GLib.file_get_contents(
        CONFIG_PATH + "/config.json"
    )[1].toString();
    
    Object.assign(daemon.identity.body, JSON.parse(config));
};


function write_daemon_config(daemon) {
    GLib.file_set_contents(
        CONFIG_PATH + "/config.json",
        JSON.stringify(daemon.identity.body),
        JSON.stringify(daemon.identity.body).length,
        null
    );
};


function read_device_cache () {
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
            log(data);
            log(typeof data);
            devices.push(JSON.parse(data));
        }
    }
    
    return devices;
};

function write_device_cache (daemon, deviceId=false) {
    if (deviceId) {
        log("updating cache for: " + deviceId);
        
        let device = daemon._devices.get(deviceId);
        
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
            write_device_cache(daemon, device.deviceId);
        }
    }
};


// FIXME: error handling
function read_device_config (deviceId) {
    let device_path = CONFIG_PATH + "/" + deviceId;
    let device_config = device_path + "/config.json";
    
    // Init Config
    if (!GLib.file_test(device_path, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(device_path, 493);
    }
        
    if (!GLib.file_test(device_config, GLib.FileTest.EXISTS)) {
        GLib.file_set_contents(
            device_config,
            '{"plugins": {}}'
        );
    }

    let config = GLib.file_get_contents(device_config)[1].toString();
    return JSON.parse(config);
};


// FIXME: error handling
function write_device_config (deviceId, config) {
    let device_config = CONFIG_PATH + "/" + deviceId + "/config.json";

    GLib.file_set_contents(
        device_config + "/config.json",
        JSON.stringify(config),
        JSON.stringify(config).length,
        null
    );
    
    return;
};


function init_config (daemon) {
    generate_encryption(false);
    
    if (GLib.file_test(CONFIG_PATH + "/config.json", GLib.FileTest.EXISTS)) {
        read_daemon_config(daemon);
    } else {
    }
};

