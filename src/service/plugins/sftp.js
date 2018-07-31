'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    incomingCapabilities: ['kdeconnect.sftp'],
    outgoingCapabilities: ['kdeconnect.sftp.request'],
    actions: {
        // TODO: stateful action???
        mount: {
            summary: _('Mount'),
            description: _('Mount a remote device'),
            icon_name: 'folder-remote-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        },
        unmount: {
            summary: _('Unmount'),
            description: _('Unmount a remote device'),
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

        if (this.device.connection_type === 'bluetooth') {
            this.destroy();
            throw Error(_('Not supported for bluetooth connections'));
        }

        if (!gsconnect.hasCommand('sshfs')) {
            this.destroy();
            throw Error(_('SSHFS not installed'));
        }
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.sftp') {
            this._parseConnectionData(packet);
        }
    }

    connected() {
        this._setup();
    }

    disconnected() {
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
            'sshfs',
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
            // Force ssh-dss (DSA) keys (deprecated >= openssh-7.0p1)
            // See: https://bugs.kde.org/show_bug.cgi?id=351725
            '-o', 'HostKeyAlgorithms=ssh-dss',
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
                let msg = stream.read_line_finish(res)[0];

                if (msg !== null) {
                    msg = msg.toString();

                    if (msg.startsWith('ssh_dispatch_run_fatal')) {
                        throw new Error(msg);
                    }

                    logWarning(msg, `${this.device.name}: ${this.name}`);
                    this._sshfs_check(stream);
                }
            } catch (e) {
                logWarning(e, `${this.device.name}: ${this.name}`);
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
        let dirSection = new Gio.Menu();

        for (let [name, path] of Object.entries(this._directories)) {
            dirSection.append(name, `device.viewFolder::${path}`);
        }

        submenu.append_section(null, dirSection);

        // Unmount Section & Item
        let unmountSection = new Gio.Menu();
        unmountSection.add_action(this.device.lookup_action('unmount'));
        submenu.append_section(null, unmountSection);

        // Directories Item
        let icon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({ name: 'folder-remote-symbolic' })
        });
        let emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({ name: 'emblem-default' })
        });
        icon.add_emblem(emblem);

        let item = new Gio.MenuItem();
        item.set_icon(icon);
        item.set_label(_('List Folders'));
        item.set_submenu(submenu);

        this.device.menu.replace_action('device.mount', item);
    }

    _removeSubmenu() {
        let index = this.device.menu.remove_labeled(_('List Folders'));
        this.device.menu.add_action(this.device.lookup_action('mount'), index);
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
     * On Linux `fusermount` will always be available but BSD uses `umount`
     * See: https://phabricator.kde.org/D6945
     */
    _umount() {
        try {
            if (gsconnect.hasCommand('fusermount')) {
                GLib.spawn_command_line_async(`fusermount -uz ${this._mountpoint}`);
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
        // Make extra sure we remove all menu items
        this.unmount();
        this._removeSubmenu();
        this.device.menu.remove_action('device.mount');

        super.destroy();
    }
});

