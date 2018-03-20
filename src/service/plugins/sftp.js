"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Browse Files"),
    description: _("Mount and browse device filesystems"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP",
    incomingPackets: ["kdeconnect.sftp"],
    outgoingPackets: ["kdeconnect.sftp.request"]
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 *
 * TODO: the Android app source that says SSHFS 3.x and causes data corruption
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

        if (!Common.checkCommand("sshfs")) {
            this.destroy();
            throw Error(_("SSHFS not installed"));
        }

        this._mounted = false;
        this._directories = {};

        if (this.settings.get_boolean("automount")) {
            this.mount();
        }
    },

    get mounted () { return this._mounted },
    get directories () { return this._directories; },

    _prepare: function () {
        debug("SFTP: _prepare()");

        this._mount_path = ext.runtimedir + "/" + this.device.id;
        GLib.mkdir_with_parents(this._mount_path, 448);

        let dir = Gio.File.new_for_path(this._mount_path);
        let info = dir.query_info("unix::uid,unix::gid", 0, null);
        this._uid = info.get_attribute_uint32("unix::uid").toString();
        this._gid = info.get_attribute_uint32("unix::gid").toString();
    },

    handlePacket: function (packet) {
        debug("SFTP: handlePacket()");

        try {
            this._prepare();
        } catch (e) {
            log("SFTP: Error preparing to mount '" + this.device.name + "': " + e);
            this.unmount();
            return;
        }

        let path = packet.body.multiPaths ? "/" : packet.body.path;

        let args = [
            "sshfs",
            packet.body.user + "@" + this.device.settings.get_string("tcp-host") + ":" + path,
            this._mount_path,
            "-p", packet.body.port.toString(),
            // "disable multi-threaded operation"
            // Fixes file chunks being sent out of order and corrupted
            "-s",
            // "foreground operation"
            "-f",
            // Do not use ~/.ssh/config
            "-F", "/dev/null",
            // Sketchy?
            "-o", "IdentityFile=" + ext.configdir + "/private.pem",
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

        let source = this._stderr.base_stream.create_source(null);
        source.set_callback(Lang.bind(this, this._read_stderr));
        source.attach(null);

        // Send session password
        this._stdin.put_string(packet.body.password + "\n", null);

        // Set the directories and notify (client.js needs this before mounted)
        if (packet.body.multiPaths) {
            for (let index in packet.body.pathNames) {
                this._directories[packet.body.pathNames[index]] = this._mount_path + packet.body.multiPaths[index];
            }
        } else {
            this._directories["All files"] = this._mount_path;
            this._directories["Camera pictures"] = this._mount_path + "/DCIM/Camera";
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
    },

    _read_stderr: function () {
        // unmount() was called with data in the queue
        if (!this._stderr) { return; }

        this._stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            let [data, len] = source.read_line_finish(res);

            // TODO: there's no way this covers all the bases
            if (data === null) {
                log("SFTP Error: pipe closed");
                this.unmount();
            } else {
                switch (data.toString()) {
                    case "remote host has disconnected":
                        debug("Sftp: disconnected");
                        this.unmount();
                    case "Timeout waiting for prompt":
                        debug("Sftp: timeout");
                        this.unmount();
                    default:
                        log("Sftp: " + data.toString());
                }
            }
        });
    },

    mount: function () {
        debug("SFTP: mount()");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.sftp.request",
            body: { startBrowsing: true }
        });

        this.device._channel.send(packet);
    },

    unmount: function () {
        debug("SFTP: unmount()");

        try {
            if (this._proc) {
               GLib.spawn_command_line_async("kill -9 " + this._proc[1]);
            }
        } catch (e) {
            log("SFTP: Error killing sshfs: " + e);
        }

        if (this._mount_path) {
            if (Common.checkCommand("fusermount")) {
                GLib.spawn_command_line_async("fusermount -uz " + this._mount_path);
            } else {
                GLib.spawn_command_line_async("umount " + this._mount_path);
            }

            delete this._mount_path;
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

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let generalSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        generalSection.addGSetting(this.settings, "automount");

        this.content.show_all();
    }
});

