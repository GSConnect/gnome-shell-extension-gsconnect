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
 *
 * TODO: reimplement automount?
 */
var Plugin = GObject.registerClass({
    Name: 'GSConnectSFTPPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._directories = {};
        this._mounted = false;
        this._mounting = false;
        this._port = 0;

        if (!hasCommand('sshfs')) {
            this.destroy();

            let error = new Error('sshfs');
            error.name = 'DependencyError';
            throw error;
        }
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.sftp') {
            this._parseConnectionData(packet);
        }
    }

    connected() {
        super.connected();

        if (this.device.connection_type === 'bluetooth') {
            this.device.lookup_action('mount').enabled = false;
        } else {
            this._setup();
            this.mount();
        }
    }

    disconnected() {
        super.disconnected();
        this.unmount();
    }

    /**
     * Ensure the mountpoint exists with the proper permissions and get the
     * UID and GID from the folder.
     *
     * TODO: If #607706 (https://bugzilla.gnome.org/show_bug.cgi?id=607706)
     *       is fixed in gvfs we can mount under $HOME and show in Nautilus
     */
    _setup() {
        try {
            // Mounting is done under /run/user/$UID/gsconnect/<device-id>
            this._mountpoint = GLib.build_filenamev([
                gsconnect.runtimedir,
                this.device.id
            ]);

            let dir = Gio.File.new_for_path(this._mountpoint);

            try {
                dir.make_directory_with_parents(null);
                dir.set_attribute_uint32('unix::mode', 448, 0, null);
            } catch (e) {
            } finally {
                let info = dir.query_info('unix::uid,unix::gid', 0, null);
                this._uid = info.get_attribute_uint32('unix::uid').toString();
                this._gid = info.get_attribute_uint32('unix::gid').toString();
            }
        } catch (e) {
            logWarning(e, `${this.device.name}: ${this.name}`);
            this._umount();
            return false;
        }

        return true;
    }

    _parseConnectionData(packet) {
        if (this._mounted) {
            return;
        }

        this._ip = this.device.settings.get_string('tcp-host');
        this._port = packet.body.port;
        this._root = packet.body.path;

        // Setup mount point
        if (!this._setup()) {
            return;
        }

        this._user = packet.body.user;
        this._password = packet.body.password;

        // If 'multiPaths' is present find the common path prefix
        if (packet.body.hasOwnProperty('multiPaths')) {
            let prefix = [];
            let paths = packet.body.multiPaths.map(path => path.split('/'));

            // Find the common prefixes
            for (let dir of paths[0]) {
                if (paths.every(path => path[0] === dir)) {
                    prefix.push(dir);
                    paths = paths.map(path => path.slice(1));
                } else {
                    break;
                }
            }

            // Rejoin the prefix and paths
            this._root = GLib.build_filenamev(prefix);
            paths = paths.map(path => '/' + GLib.build_filenamev(path));

            // Set the directories
            for (let i = 0; i < paths.length; i++) {
                let name = packet.body.pathNames[i];
                this._directories[name] = this._mountpoint + paths[i];
            }

        // If 'multiPaths' is missing use 'path' and assume a Camera folder
        } else {
            this._root = packet.body.path;
            this._directories[_('All files')] = this._mountpoint;
            this._directories[_('Camera pictures')] =  GLib.build_filenamev([
                this._mountpoint,
                'DCIM',
                'Camera'
            ]);
        }

        // Start the mounting process
        this._mount();
    }

    /**
     * Start the sshfs process and send the password
     */
    _sshfs() {
        let argv = [
            gsconnect.metadata.bin.sshfs,
            `${this._user}@${this._ip}:${this._root}`,
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
            // Allow ssh-dss (DSA) keys (deprecated >= openssh-7.0p1)
            // See: https://bugs.kde.org/show_bug.cgi?id=351725
            '-o', 'HostKeyAlgorithms=+ssh-dss',
            // Match keepalive for kdeconnect connection (30sx3)
            '-o', 'ServerAliveInterval=30',
            // Don't immediately connect to server, wait until mountpoint is first accessed.
            '-o', 'delay_connect',
            // Automatically reconnect to server if connection is interrupted
            '-o', 'reconnect',
            // Set user/group permissions to allow readwrite access
            '-o', `uid=${this._uid}`, '-o', `gid=${this._gid}`,
            // 'read password from stdin (only for pam_mount!)'
            '-o', 'password_stdin'
        ];

        // Execute sshfs
        this._proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        this._proc.init(null);

        // Cleanup when the process exits
        this._proc.wait_async(null, this._sshfs_finish.bind(this));

        // Since we're using '-o reconnect' we watch stderr so we can quit on
        // errors *we* consider fatal, otherwise the process may dangle
        let stderr = new Gio.DataInputStream({
            base_stream: this._proc.get_stderr_pipe()
        });
        this._sshfs_check(stderr);

        // Send session password
        this._proc.get_stdin_pipe().write_all_async(
            `${this._password}\n`,
            GLib.PRIORITY_DEFAULT,
            null,
            (stream, res) => {
                try {
                    stream.write_all_finish(res);
                } catch (e) {
                    this.unmount();
                }
            }
        );
    }

    _sshfs_finish(proc, res) {
        try {
            proc.wait_finish(res);
        } catch (e) {
            debug(e);
        } finally {
            this._proc = undefined;

            // Make sure it's actually unmounted
            this._umount();

            // Reset the directories and 'mounted'
            this._directories = {};
            this._mounted = false;

            // Replace the menu item
            this._removeSubmenu();
        }
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
                        let e = new Error(msg);

                        if (msg.includes('incorrect signature')) {
                            e.name = 'SSHSignatureError';
                            e.deviceName = this.device.name;
                        }

                        this.service.notify_error(e);
                        throw e;
                    }

                    logWarning(msg, `${this.device.name}: ${this.name}`);
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

        for (let [name, path] of Object.entries(this._directories)) {
            directories.append(name, `device.openPath::${path}`);
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
        // TODO: better?
        let icon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({ name: 'folder-remote-symbolic' })
        });
        let emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({ name: 'emblem-default' })
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
        let action = this.device.lookup_action('mount')

        if (action !== null) {
            this.device.menu.add_action(action, index);
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.sftp.request',
            body: { startBrowsing: true }
        });
    }

    /**
     * Run sshfs and replace the
     */
    _mount() {
        try {
            // If mounting is already in progress, let that fail before retrying
            if (this._mounting) {
                return;
            }

            this._mounting = true;

            // Start sshfs
            this._sshfs();

            // Add the directories to the menu
            this._addSubmenu();

            // Set 'mounted'
            this._mounted = true;
            this._mounting = false;
        } catch (e) {
            this.unmount();
            logError(e, this.device.name);
        }
    }

    /**
     * On Linux `fusermount` should be available, but BSD uses `umount`
     * See: https://phabricator.kde.org/D6945
     */
    _umount() {
        try {
            if (hasCommand('fusermount')) {
                GLib.spawn_command_line_async(`${gsconnect.metadata.bin.fusermount} -uz ${this._mountpoint}`);
            } else {
                GLib.spawn_command_line_async(`umount ${this._mountpoint}`);
            }

            this._mounted = false;
        } catch (e) {
            logWarning(e, this.device.name);
        }
    }

    /**
     * Remove the menu items, kill sshfs, replace the mount item
     */
    unmount() {
        if (!this._mounted) {
            return;
        }

        this._umount();

        if (this._mounted) {
            this._proc.force_exit();
        }
    }

    destroy() {
        // FIXME: _sshfs_finish() accesses plugin variables after finalization
        this.unmount();
        super.destroy();
    }
});

