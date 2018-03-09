"use strict";

const Lang = imports.lang;
const Format = imports.format;
const Gettext = imports.gettext;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;


/**
 * Application Id and Path
 * TODO: these should mirror package.js
 */
gsconnect.app_id = "org.gnome.Shell.Extensions.GSConnect";
gsconnect.app_path = "/org/gnome/Shell/Extensions/GSConnect";
gsconnect.metadata = JSON.parse(GLib.file_get_contents(gsconnect.datadir + "/metadata.json")[1]);


/**
 * User Directories
 * TODO: these should mirror package.js
 */
gsconnect.cachedir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gsconnect"]);
gsconnect.configdir = GLib.build_filenamev([GLib.get_user_config_dir(), "gsconnect"]);
gsconnect.runtimedir = GLib.build_filenamev([GLib.get_user_runtime_dir(), "gsconnect"]);

for (let path of [gsconnect.cachedir, gsconnect.configdir, gsconnect.runtimedir]) {
    GLib.mkdir_with_parents(path, 448);
}

/**
 * Gettext
 * TODO: these should mirror package.js
 */
gsconnect.localedir = GLib.build_filenamev([gsconnect.datadir, "locale"]);

Gettext.bindtextdomain(gsconnect.app_id, gsconnect.localedir);
Gettext.textdomain(gsconnect.app_id);

// If we aren't inside the Gnome Shell process, set gettext on the global. Any
// script *inside* the proc should set these manually from gsconnect.*
if (typeof _ !== "function") {
    window._ = Gettext.gettext;
    window.ngettext = Gettext.ngettext;
    window.N_ = function (s) { return s; };
    window.C_ = Gettext.pgettext;
} else {
    gsconnect._ = Gettext.gettext;
    gsconnect.ngettext = Gettext.ngettext;
    gsconnect.N_ = function (s) { return s; };
    gsconnect.C_ = Gettext.pgettext;
}


/**
 * Init GSettings
 * TODO: these should mirror package.js
 */
gsconnect.gschema = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([gsconnect.datadir, "schemas"]),
    Gio.SettingsSchemaSource.get_default(),
    false
);

gsconnect.settings = new Gio.Settings({
    settings_schema: gsconnect.gschema.lookup(gsconnect.app_id, true)
});


/**
 * Register resources
 * TODO: these should mirror package.js
 */
gsconnect.resource = Gio.Resource.load(
    GLib.build_filenamev([gsconnect.datadir, gsconnect.app_id + ".data.gresource"])
);
gsconnect.resource._register();


/**
 * DBus Interface Introspection
 */
gsconnect.dbusinfo = new Gio.DBusNodeInfo.new_for_xml(
    Gio.resources_lookup_data(
        gsconnect.app_path + "/" + gsconnect.app_id + ".xml",
        0
    ).toArray().toString()
);
gsconnect.dbusinfo.nodes.forEach(info => info.cache_build());


/**
 * If "debug" is enabled in GSettings, Print a message to the log, prepended
 * with the UUID of the extension.
 * @param {String} msg - the debugging message
 */
gsconnect.settings.connect("changed::debug", () => {
    if (gsconnect.settings.get_boolean("debug")) {
        window.debug = function (msg) {
            // Stack regexp
            let _dbgRegexp = /(?:(?:([^<.]+)<\.)?([^@]+))?@(.+):(\d+):\d+/g;
            let e = (msg.stack) ? msg : new Error();
            let [m, k, f, fn, l] = _dbgRegexp.exec(e.stack.split("\n")[1]);
            fn = GLib.path_get_basename(fn);

            // There's a better way...
            let hdr = [gsconnect.metadata.name, fn, k, f, l].filter(k => (k)).join(":");

            // fix msg if not string
            if (msg.stack) {
                msg = msg.message + "\n" + msg.stack;
            } else if (typeof msg !== "string") {
                msg = JSON.stringify(msg);
            }

            log("[" + hdr + "]: " + msg);
        };
    } else {
        window.debug = function () { return; };
    }
});
gsconnect.settings.emit("changed::debug", "debug");


/**
 * Check if a command is in the PATH
 * @param {string} name - the name of the command
 */
gsconnect.checkCommand = function(cmd) {
    let proc = GLib.spawn_async_with_pipes(
        null,                           // working dir
        ["which", cmd],                // argv
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
 * Install/Uninstall desktop files for user installs
 *     - XDG .desktop file
 *     - DBus .service file
 *     - Register sms:// scheme handler
 */
gsconnect.installService = function() {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    let serviceFile = gsconnect.app_id + ".service";
    let serviceBytes = Gio.resources_lookup_data(
        gsconnect.app_path + "/" + serviceFile, 0
    ).toArray().toString().replace("@DATADIR@", gsconnect.datadir);

    GLib.mkdir_with_parents(serviceDir, 493);
    GLib.file_set_contents(serviceDir + serviceFile, serviceBytes);

    // Application desktop file
    let applicationsDir = GLib.get_user_data_dir() + "/applications/";
    let desktopFile = gsconnect.app_id + ".desktop";
    let desktopBytes = Gio.resources_lookup_data(
        gsconnect.app_path + "/" + desktopFile, 0
    ).toArray().toString().replace("@DATADIR@", gsconnect.datadir);

    GLib.mkdir_with_parents(applicationsDir, 493);
    GLib.file_set_contents(applicationsDir + desktopFile, desktopBytes);

    // sms:// scheme handler
    let appinfo = Gio.DesktopAppInfo.new_from_filename(
        applicationsDir + desktopFile
    );
    appinfo.add_supports_type("x-scheme-handler/sms");
};


// FIXME: Not used anymore, should just be ignored by the shell
gsconnect.uninstallService = function() {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    GLib.unlink(serviceDir + gsconnect.app_id + ".service");

    // Application desktop file
    let applicationsDir = GLib.get_user_data_dir() + "/applications/";
    GLib.unlink(applicationsDir + gsconnect.app_id + ".desktop");
};


/**
 * Recursively pack a GLib.Variant from a JSON-compatible object
 */
gsconnect.full_pack = function(obj) {
    if (obj instanceof GLib.Variant) {
        return obj;
    } else if (typeof obj === "string") {
        return GLib.Variant.new("s", obj);
    } else if (typeof obj === "number") {
        return GLib.Variant.new("d", obj);
    } else if (typeof obj === "boolean") {
        return GLib.Variant.new("b", obj);
    } else if (typeof obj.map === "function") {
        return GLib.Variant.new("av", obj.map(i => gsconnect.full_pack(i)));
    } else if (typeof obj === "object" && typeof obj !== null) {
        let packed = {};

        for (let key in obj) {
            packed[key] = gsconnect.full_pack(obj[key]);
        }

        return GLib.Variant.new("a{sv}", packed);
    }

    return null;
};


/**
 * Recursively deep_unpack() a GLib.Variant
 */
gsconnect.full_unpack = function(obj) {
    if (typeof obj.deep_unpack === "function") {
        return gsconnect.full_unpack(obj.deep_unpack());
    } else if (typeof obj.map === "function") {
        return obj.map(i => gsconnect.full_unpack(i));
    } else if (typeof obj === "object" && typeof obj !== null) {
        let unpacked = {};

        for (let key in obj) {
            unpacked[key] = gsconnect.full_unpack(obj[key]);
        }

        return unpacked;
    }

    // FIXME: huh?
    return obj;
};


Gio.Notification.prototype.add_device_button = function (label, dbusPath, name, ...args) {
    try {
        let vargs = args.map(arg => gsconnect.full_pack(arg));
        log(vargs);
        //let vargs = gsconnect.full_pack(args);
        let parameter = new GLib.Variant("(ssav)", [dbusPath, name, vargs]);
        this.add_button_with_target(label, "app.deviceAction", parameter);
    } catch(e) {
        debug("Error adding button: " + [label, dbusPath, name].join(","));
        debug(e);
    }
};


Gio.Notification.prototype.set_device_action = function (dbusPath, name, ...args) {
    try {
        let vargs = args.map(arg => gsconnect.full_pack(arg));
        log(vargs);
        let parameter = new GLib.Variant("(ssav)", [dbusPath, name, vargs]);
        this.set_default_action_and_target("app.deviceAction", parameter);
    } catch(e) {
        debug("Error setting action: " + [dbusPath, name].join(","));
        debug(e);
    }
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


Gio.DBusObjectManagerClient.prototype.get_devices = function () {
    let devices = [];

    for (let obj of this.get_objects()) {
        for (let iface of obj.get_interfaces()) {
            if (iface.g_interface_name === "org.gnome.Shell.Extensions.GSConnect.Device") {
                devices.push(iface);
            }
        }
    }

    return devices;
};


//
Gio.MenuModel.prototype[Symbol.iterator] = function* _menuModelIterator() {
    let _index = 0;
    const _len = this.get_n_items();

    while (_index < _len) {
        yield {
            action: this.get_item_attribute_value(_index, "action", null).unpack(),
            label: this.get_item_attribute_value(_index, "label", null).unpack(),
            icon: this.get_item_attribute_value(_index, "icon", null).deep_unpack()[1].deep_unpack()[0]
        };

        _index++;
    }
}


/**
 * String.format API supporting %s, %d, %x and %f
 * See: https://github.com/GNOME/gjs/blob/master/modules/format.js
 */
String.prototype.format = Format.format;


/**
 * String tranformation prototypes
 */
String.prototype.toDBusCase = function(string) {
    string = string || this;

    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
};

// FIXME
String.prototype.toDBusSafe = function(string) {
    string = string || this;
    return string.replace(/[^A-Za-z0-9_]+/g, "_");
};


// FIXME
String.prototype.toGSettingsSafe = function(string) {
    string = string || this;
    return string.replace(/[^a-z0-9-]+/g, "_");
};


String.prototype.toCamelCase = function(string) {
    string = string || this;

    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return (offset === 0) ? ltr.toLowerCase() : ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
};


String.prototype.toHyphenCase = function(string) {
    string = string || this;

	return string.replace(/(?:[A-Z])/g, (ltr, offset) => {
        return (offset > 0) ? "-" + ltr.toLowerCase() : ltr.toLowerCase();
	}).replace(/[\s_]+/g, '');
};


String.prototype.toUnderscoreCase = function(string) {
    string = string || this;

	return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
	    if (ltr === "_") return "";
        return (offset > 0) ? "_" + ltr.toLowerCase() : ltr.toLowerCase();
	}).replace(/[\s-]+/g, '');
};

