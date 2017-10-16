"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "sftp",
    summary: _("Browse Files"),
    description: _("Mount and browse device filesystems"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Browse-Files-Plugin",
    incomingPackets: ["kdeconnect.sftp"],
    outgoingPackets: ["kdeconnect.sftp.request"],
    settings: {
        automount: false
    }
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 *
 * TODO: mountWait() and timeout
 *       umount vs fusermount vs -autounmount switch
 *       stderr checking
 */
var Plugin = new Lang.Class({
    Name: "GSConnectSFTPPlugin",
    Extends: PluginsBase.Plugin,
    Properties: {
        "directories": GObject.param_spec_variant(
            "directories",
            "mountedDirectories",
            "Directories on the mounted device",
            new GLib.VariantType("a{sv}"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "mounted": GObject.ParamSpec.boolean(
            "mounted",
            "deviceMounted",
            "Whether the device is mounted",
            GObject.ParamFlags.READABLE,
            false
        )
    },
    
    _init: function (device) {
        this.parent(device, "sftp");
        
        if (!this._check_sshfs()) {
            this.destroy();
            throw Error(_("SSHFS not installed"));
        }
        
        this._mounted = false;
        this._directories = {};
        
        if (this.settings.automount) {
            this.mount();
        }
    },
    
    get mounted () { return this._mounted },
    get directories () { return this._directories; },
    
    _check_sshfs: function () {
        let proc = GLib.spawn_async_with_pipes(
            null,                                   // working dir
            ["which", "sshfs"],                     // argv
            null,                                   // envp
            GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
            null                                    // child_setup (func)
        );
        
        let stdout = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: proc[3] })
        });
        let [result, length] = stdout.read_line(null);
        stdout.close(null);
        
        if (result === null) {
            return false;
        } else {
            log("result: '" + result.toString() + "'");
            return true;
        }
    },
    
    _prepare: function () {
        Common.debug("SFTP: _prepare()");
        
        this._path = Common.CONFIG_PATH + "/" + this.device.id + "/sftp";
        
        if (!GLib.file_test(this._path, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(this._path, 493);
        }
        
        // TODO: better way to get this?
        let dir = Gio.File.new_for_path(this._path);
        let info = dir.query_info("unix::uid,unix::gid", 0, null);
        this._uid = info.get_attribute_uint32("unix::uid").toString();
        this._gid = info.get_attribute_uint32("unix::gid").toString();
    },
    
    handlePacket: function (packet) {
        Common.debug("SFTP: handlePacket()");
        //"ip":"192.168.1.69",
        //"port":1739,
        //"user":"kdeconnect",
        //"password":"uNoMxe1ZsaFTssdaP3T0zDVMo2D5",
        //"path":"/storage/emulated/0",
        //"multiPaths":["/storage/emulated/0","/storage/emulated/0/DCIM/Camera"],
        //"pathNames":["All files","Camera pictures"]
        
        try {
            this._prepare();
        } catch (e) {
            log("SFTP: Error preparing to mount '" + this.device.name + "': " + e);
            this.unmount();
            return;
        }

        let args = [
            "sshfs",
            packet.body.user + "@" + packet.body.ip + ":" + packet.body.path,
            this._path,
            "-p", packet.body.port.toString(),
            // "disable multi-threaded operation"
            // Fixes file chunks being sent out of order and corrupted
            "-s",
            // "foreground operation"
            "-f",
            // Do not use ~/.ssh/config
            "-F", "/dev/null",
            // Sketchy?
            "-o", "IdentityFile=" + Common.CONFIG_PATH + "/private.pem",
            // Don't prompt for new host confirmation (we know the host)
            "-o", "StrictHostKeyChecking=no",
            // Prevent storing as a known host
            "-o", "UserKnownHostsFile=/dev/null",
            // ssh-dss (DSA) keys are deprecated since openssh-7.0p1
            // See: https://bugs.kde.org/show_bug.cgi?id=351725
            "-o", "HostKeyAlgorithms=ssh-dss",
            "-o", "ServerAliveInterval=30",
            // "set file owner/group"
            "-o", "uid=" + this._uid, "-o", "gid=" + this._gid,
            // "read password from stdin (only for pam_mount!)"
            "-o", "password_stdin"
        ];
        
        // [res, pid, in_fd, out_fd, err_fd]
        try {
            this._proc = GLib.spawn_async_with_pipes(
                null,                                   // working dir
                args,                                   // argv
                null,                                   // envp
                GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
                null                                    // child_setup (func)
            );
        } catch (e) {
            log("SFTP: Error mounting '" + this.device.name + "': " + e);
            this.unmount();
            return;
        }
            
        
        // Initialize streams
        this._stdin = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({ fd: this._proc[2] })
        });
        
        this._stderr = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._proc[4] })
        });
        
        // Send session password
        this._stdin.put_string(packet.body.password + "\n", null);
        
        // Set the directories and notify (client.js needs this before mounted)
        for (let index in packet.body.pathNames) {
            let name = packet.body.pathNames[index];
            let path = packet.body.multiPaths[index].replace(packet.body.path, "");
            path = path.replace(packet.body.path, "");
        
            this._directories[name] = this._path + path;
        }
        
        this.notify("directories");
        this._dbus.emit_property_changed(
            "directories",
            new GLib.Variant("a{ss}", this._directories)
        );
        
        // Set "mounted" and notify
        this._mounted = true;
        
        this.notify("mounted");
        this._dbus.emit_property_changed(
            "mounted",
            new GLib.Variant("b", this._mounted)
        );
        
        this._read_stderr();
    },
    
    // FIXME: seems super sketch
    _read_stderr: function () {
        this._stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            let [data, len] = source.read_line_finish(res);
            
            if (data.toString() === "remote host has disconnected") {
                log("SFTP Error: remote host has disconnected");
                this.unmount();
            } else if (data !== null) {
                log("SFTP stderr: " + data);
            
                this._read_stderr();
            }
        });
    },
    
    mount: function () {
        Common.debug("SFTP: mount()");
        
        let packet = new Protocol.Packet();
        packet.type = "kdeconnect.sftp.request";
        packet.body = { startBrowsing: true };
        
        this.device._channel.send(packet);
    },
    
    unmount: function () {
        Common.debug("SFTP: unmount()");
    
        try {
            if (this._proc) {
               GLib.spawn_command_line_async("kill -9 " + this._proc[1]);
            }
        } catch (e) {
            log("SFTP: Error killing sshfs: " + e);
        }
        
        // See: https://stackoverflow.com/q/24966676/1108697
        if (this._path) {
            GLib.spawn_command_line_async("fusermount -uz " + this._path);
            delete this._path;
            delete this._uid;
            delete this._gid;
        }
        
        try {
            if (this._stdin) {
                this._stdin.close(null);
            }
        } catch (e) {
            log("SFTP: Error closing stdin: " + e);
        }
        
        // TODO: Gio.IOErrorEnum: Stream has outstanding operation
        try {
            if (this._stderr) {
                this._stderr.close(null);
            }
        } catch (e) {
            log("SFTP: Error closing stderr: " + e);
        }
        
        delete this._proc;
        delete this._stdin;
        delete this._stderr;
        
        this._directories = {};
        
        this._dbus.emit_property_changed(
            "directories",
            new GLib.Variant("a{ss}", this._directories)
        );
        
        this._mounted = false;
        
        this._dbus.emit_property_changed(
            "mounted",
            new GLib.Variant("b", false)
        );
    },
    
    destroy: function () {
        this.unmount();
        
        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectSFTPSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        let generalSection = this.content.addSection(_("General"));
        
        let automountSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.automount
        });
        automountSwitch.connect("notify::active", (widget) => {
            this.settings.automount = automountSwitch.automount;
        });
        this.content.addItem(
            generalSection,
            _("Automount"),
            // TRANSLATORS: eg. Attempt to mount Google Pixel when it connects
            _("Attempt to mount %s when it connects").format(this._page.device.name),
            automountSwitch
        );
        
        this.content.show_all();
    }
});

