'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('SFTP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    incomingCapabilities: ['kdeconnect.sftp'],
    outgoingCapabilities: ['kdeconnect.sftp.request'],
    actions: {
        mount: {
            label: _('Mount'),
            icon_name: 'folder-remote-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        },
        unmount: {
            label: _('Unmount'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        }
    }
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
var Plugin = GObject.registerClass({
    Name: 'GSConnectSFTPPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._directories = {};
        this._mount = null;
        this._mounting = false;
    }

    get has_sshfs() {
        return GLib.find_program_in_path(gsconnect.metadata.bin.sshfs);
    }

    get ip() {
        // Always use the IP from the current connection
        return this.device.settings.get_string('tcp-host');
    }

    handlePacket(packet) {
        // Ensure we don't mount on top of an existing mount
        // FIXME: might need to update old mounts?
        if (this._mount) {
            debug('already mounted', this.device.name);
            return;
        }

        if (packet.type === 'kdeconnect.sftp') {
            this._agnostic_mount(packet.body);
        }
    }

    connected() {
        super.connected();

        // Disable for all bluetooth connections
        if (this.device.connection_type === 'bluetooth') {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;

        // Request a mount; if using sshfs we will "delay-connect"
        } else {
            this.mount();
        }
    }

    disconnected() {
        super.disconnected();
        this.unmount();
    }

    /**
     * Setup the directories for export with GMenu and store the mountpoint. For
     * `sshfs` we also ensure the local mountpoint is ready and get the UID/GID.
     *
     * TODO: If #607706 (https://bugzilla.gnome.org/show_bug.cgi?id=607706)
     *       is fixed in gvfs we can mount sshfs in $HOME and show in Nautilus
     *
     * @param {object} info - The body of a kdeconnect.sftp packet
     */
    async _setup(info) {
        try {
            this._user = info.user;
            this._password = info.password;
            this._port = info.port;

            // Ensure mountpoint is ready for sshfs
            if (this.has_sshfs) {
                this._mountpoint = GLib.build_filenamev([
                    gsconnect.runtimedir,
                    this.device.id
                ]);
                this._uri = `file://${this._mountpoint}`;

                let dir = Gio.File.new_for_path(this._mountpoint);

                try {
                    dir.make_directory_with_parents(null);
                    dir.set_attribute_uint32('unix::mode', 448, 0, null);
                } catch (e) {
                }

                // Grab the uid/gid from the mountpoint
                await new Promise((resolve, reject) => {
                    dir.query_info_async('unix::*', 0, 0, null, (dir, res) => {
                        try {
                            let finfo = dir.query_info_finish(res);
                            this._uid = finfo.get_attribute_uint32('unix::uid');
                            this._gid = finfo.get_attribute_uint32('unix::gid');
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

            // Otherwise just store the mountpoint's URI
            } else {
                this._uri = `sftp://${this.ip}:${this._port}/`;

                // HACK: Test an SFTP mount for this IP in the 1716-1764 range
                this._uriRegex = new RegExp(`sftp://(${this.ip}):(171[6-9]|17[2-5][0-9]|176[0-4])`);
            }

            // If 'multiPaths' is present setup a local URI for each
            if (info.hasOwnProperty('multiPaths')) {
                for (let i = 0; i < info.multiPaths.length; i++) {
                    let name = info.pathNames[i];
                    let path = info.multiPaths[i];
                    this._directories[name] = this._uri + path;
                }

            // If 'multiPaths' is missing use 'path' and assume a Camera folder
            } else {
                let uri = this._uri + info.path;
                this._directories[_('All files')] = uri;
                this._directories[_('Camera pictures')] = uri + 'DCIM/Camera';
            }

            return Promise.resolve(true);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async _sftp_mount() {
        try {
            let op = new Gio.MountOperation({
                username: this._user,
                password: this._password,
                password_save: Gio.PasswordSave.NEVER
            });

            // We already know the host, so just accept
            op.connect('ask-question', (op, message, choices) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // We set the password, so just accept
            op.connect('ask-password', (op, message, user, domain, flags) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // This is the actual call to mount the device
            await new Promise((resolve, reject) => {
                let file = Gio.File.new_for_uri(this._uri);

                file.mount_enclosing_volume(0, op, null, (file, res) => {
                    try {
                        resolve(file.mount_enclosing_volume_finish(res));
                    } catch (e) {
                        // TODO: special case when the GMount didn't unmount
                        // properly but is still on the same port (code 17).
                        if (e.code && e.code === Gio.IOErrorEnum.ALREADY_MOUNTED) {
                            warning(e, this.device.name);
                            resolve(true);
                        } else {
                            reject(e);
                        }
                    }
                });
            });

            // Get the GMount from GVolumeMonitor
            let monitor = Gio.VolumeMonitor.get();

            for (let mount of monitor.get_mounts()) {
                let uri = mount.get_root().get_uri();

                // Check if this is our mount
                if (this._uri === uri) {
                    this._mount = mount;

                // Or if it's a stale mount we need to cleanup
                } else if (this._uriRegex.test(uri)) {
                    warning('Removing stale GMount', this.device.name);
                    await this._sftp_unmount(mount);
                }
            }

            return Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }

    _sftp_unmount(mount) {
        return new Promise((resolve, reject) => {
            let op = new Gio.MountOperation();

            mount.unmount_with_operation(1, op, null, (mount, res) => {
                try {
                    resolve(mount.unmount_with_operation_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Start the sshfs process and send the password
     */
    async _sshfs_mount() {
        try {
            let argv = [
                gsconnect.metadata.bin.sshfs,
                `${this._user}@${this.ip}:/`,
                this._mountpoint,
                '-p', this._port.toString(),
                // 'disable multi-threaded operation'
                // Fixes file chunks being sent out of order and corrupted
                '-s',
                // 'foreground operation'
                '-f',
                // Do not use ~/.ssh/config
                '-F', '/dev/null',
                // Use the private key from the service certificate
                '-o', 'IdentityFile=' + gsconnect.configdir + '/private.pem',
                // Don't prompt for new host confirmation (we know the host)
                '-o', 'StrictHostKeyChecking=no',
                // Prevent storing as a known host
                '-o', 'UserKnownHostsFile=/dev/null',
                // Match keepalive for kdeconnect connection (30sx3)
                '-o', 'ServerAliveInterval=30',
                // Wait until mountpoint is first accessed to connect
                '-o', 'delay_connect',
                // Reconnect to server if connection is interrupted
                '-o', 'reconnect',
                // Set user/group permissions to allow readwrite access
                '-o', `uid=${this._uid}`, '-o', `gid=${this._gid}`,
                // 'read password from stdin (only for pam_mount!)'
                '-o', 'password_stdin'
            ];

            // Execute sshfs
            this._mount = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            this._mount.init(null);

            // Cleanup when the process exits
            this._mount.wait_async(null, this._sshfs_unmount.bind(this));

            // Since we're using '-o reconnect' we watch stderr so we can quit
            // on errors *we* consider fatal, otherwise the process may dangle
            let stderr = new Gio.DataInputStream({
                base_stream: this._mount.get_stderr_pipe()
            });
            this._sshfs_check(stderr);

            // Send session password
            return new Promise((resolve, reject) => {
                this._mount.get_stdin_pipe().write_all_async(
                    `${this._password}\n`,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (stream, res) => {
                        try {
                            resolve(stream.write_all_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    _sshfs_unmount(proc, res) {
        // This is the callback for Gio.Subprocess.wait_async()
        try {
            proc.wait_finish(res);
        } catch (e) {
            // Silence errors
        } finally {
            this._mount = null;
        }

        // Skip if there's no mountpoint defined
        if (!this._mountpoint) return Promise.resolve();

        // We also call fusermount/umount to ensure it's actually unmounted
        let argv = [gsconnect.metadata.bin.fusermount, '-uz', this._mountpoint];

        // On Linux `fusermount` should be available, but BSD uses `umount`
        // See: https://phabricator.kde.org/D6945
        if (!GLib.find_program_in_path(gsconnect.metadata.bin.fusermount)) {
            argv = ['umount', this._mountpoint];
        }

        return new Promise ((resolve, reject) => {
            let proc = new Gio.Subprocess({argv: argv});
            proc.init(null);

            proc.wait_async(null, (proc, res) => {
                try {
                    resolve(proc.wait_finish(res));
                } catch (e) {
                    // Silence errors
                    resolve();
                }
            });
        });
    }

    /**
     * Watch stderr output from the sshfs process for fatal errors
     */
    _sshfs_check(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                let msg = stream.read_line_finish_utf8(res)[0];

                if (msg !== null) {
                    if (msg.includes('ssh_dispatch_run_fatal')) {
                        throw new Error(msg);
                    }

                    warning(msg, `${this.device.name}: sshfs`);
                    this._sshfs_check(stream);
                }
            } catch (e) {
                debug(e);
                this.unmount();
            }
        });
    }

    /**
     * Replace the 'Mount' item with a submenu of directories
     */
    _addSubmenu() {
        // Sftp Submenu
        let submenu = new Gio.Menu();

        // Directories Section
        let directories = new Gio.Menu();

        for (let [name, uri] of Object.entries(this._directories)) {
            directories.append(name, `device.openPath::${uri}`);
        }

        submenu.append_section(null, directories);

        // Unmount Section/Item
        let unmount = new Gio.Menu();
        unmount.add_action(this.device.lookup_action('unmount'));
        submenu.append_section(null, unmount);

        // Files Item
        let item = new Gio.MenuItem();
        item.set_detailed_action('device.mount');

        // Icon with check emblem
        // TODO: this emblem often isn't very visible
        let icon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'})
        });
        let emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({name: 'emblem-default'})
        });
        icon.add_emblem(emblem);
        item.set_icon(icon);

        item.set_attribute_value(
            'hidden-when',
            new GLib.Variant('s', 'action-disabled')
        );
        item.set_label(_('Files'));
        item.set_submenu(submenu);

        this.device.menu.replace_action('device.mount', item);
    }

    _removeSubmenu() {
        let index = this.device.menu.remove_action('device.mount');
        let action = this.device.lookup_action('mount');

        if (action !== null) {
            this.device.menu.add_action(action, index);
        }
    }

    /**
     * TODO: Transitional wrapper until Gio is thoroughly tested
     *
     * @param {packet} info - The body of a kdeconnect.sftp packet
     */
    async _agnostic_mount(info) {
        try {
            // If mounting is already in progress, let that fail before retrying
            if (this._mounting) return;
            this._mounting = true;

            await this._setup(info);

            // Prefer sshfs
            if (this.has_sshfs) {
                await this._sshfs_mount();

            // Fallback to Gio
            } else {
                debug('sshfs not found: falling back to GMount');
                await this._sftp_mount();
            }

            // Populate the menu
            this._addSubmenu();
            this._mounting = false;
        } catch (e) {
            logError(e, `${this.device.name}: ${this.name}`);
            this._mounting = false;
            this.unmount();
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        this.device.sendPacket({
            type: 'kdeconnect.sftp.request',
            body: {startBrowsing: true}
        });
    }

    /**
     * Remove the menu items, unmount the filesystem, replace the mount item
     */
    async unmount() {
        try {
            debug('unmounting', this.device.name);

            // Skip since this will always fail
            if (!this._mount) {
                // pass

            // TODO: Transitional wrapper until Gio is thoroughly tested
            } else if (this.has_sshfs) {
                await this._sshfs_unmount(null, null);
            } else {
                await this._sftp_unmount(this._mount);
            }
        } catch (e) {
            debug(e, this.device.name);

        // Always reset the state and menu
        } finally {
            debug('unmounted', this.device.name);

            this._directories = {};
            this._mount = null;
            this._mounting = false;
            this._removeSubmenu();
        }
    }

    destroy() {
        this.unmount();
        super.destroy();
    }
});

