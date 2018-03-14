"use strict";

const Lang = imports.lang;
const Format = imports.format;
const Gettext = imports.gettext;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

//
ext.app_id = "org.gnome.Shell.Extensions.GSConnect";
ext.app_path = "/org/gnome/Shell/Extensions/GSConnect";

ext.metadata = JSON.parse(GLib.file_get_contents(ext.datadir + "/metadata.json")[1]);
ext.localedir = GLib.build_filenamev([ext.datadir, "locale"]);
Gettext.bindtextdomain(ext.app_id, ext.localedir);

ext.cachedir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gsconnect"]);
ext.configdir = GLib.build_filenamev([GLib.get_user_config_dir(), "gsconnect"]);
ext.runtimedir = GLib.build_filenamev([GLib.get_user_runtime_dir(), "gsconnect"]);

for (let path of [ext.cachedir, ext.configdir, ext.runtimedir]) {
    GLib.mkdir_with_parents(path, 448);
}


/**
 * Init GSettings
 */
ext.gschema = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([ext.datadir, "schemas"]),
    Gio.SettingsSchemaSource.get_default(),
    false
);

ext.settings = new Gio.Settings({
    settings_schema: ext.gschema.lookup(ext.app_id, true)
});


/**
 * Register resources
 */
ext.resource = Gio.Resource.load(
    GLib.build_filenamev([ext.datadir, ext.app_id + ".data.gresource"])
);
ext.resource._register();


/**
 * DBus Interface Introspection
 */
ext.dbusinfo = new Gio.DBusNodeInfo.new_for_xml(
    Gio.resources_lookup_data(
        ext.app_path + "/" + ext.app_id + ".xml",
        0
    ).toArray().toString()
);
ext.dbusinfo.nodes.forEach((ifaceInfo) => { ifaceInfo.cache_build(); });


/**
 * If "debug" is enabled in GSettings, Print a message to the log, prepended
 * with the UUID of the extension.
 * @param {String} msg - the debugging message
 */
window.debug = function (msg) {
    if (ext.settings.get_boolean("debug")) {
        log("[gsconnect@andyholmes.github.io]: " + msg);
    }
};


/**
 * Check if a command is in the PATH
 * @param {string} name - the name of the command
 */
function checkCommand (cmd) {
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
function installService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    let serviceFile = ext.app_id + ".service";
    let serviceBytes = Gio.resources_lookup_data(
        ext.app_path + "/" + serviceFile, 0
    ).toArray().toString().replace("@DATADIR@", ext.datadir);

    GLib.mkdir_with_parents(serviceDir, 493);
    GLib.file_set_contents(serviceDir + serviceFile, serviceBytes);

    // Application desktop file
    let applicationsDir = GLib.get_user_data_dir() + "/applications/";
    let desktopFile = ext.app_id + ".desktop";
    let desktopBytes = Gio.resources_lookup_data(
        ext.app_path + "/" + desktopFile, 0
    ).toArray().toString().replace("@DATADIR@", ext.datadir);

    GLib.mkdir_with_parents(applicationsDir, 493);
    GLib.file_set_contents(applicationsDir + desktopFile, desktopBytes);

    // sms:// scheme handler
    let appinfo = Gio.DesktopAppInfo.new_from_filename(
        applicationsDir + desktopFile
    );
    appinfo.add_supports_type("x-scheme-handler/sms");
};


function uninstallService () {
    // DBus service file
    let serviceDir = GLib.get_user_data_dir() + "/dbus-1/services/";
    GLib.unlink(serviceDir + ext.app_id + ".service");

    // Application desktop file
    let applicationsDir = GLib.get_user_data_dir() + "/applications/";
    GLib.unlink(applicationsDir + ext.app_id + ".desktop");
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
    let output = stdout.read_line(null)[0].toString();
    stdout.close(null);

    return /[a-zA-Z0-9\-]{36}/.exec(output)[0];
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

