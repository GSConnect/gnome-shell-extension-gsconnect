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
 * {
 *     'id': 1518956413092,
 *     'type':'kdeconnect.sftp',
 *     'body': {
 *         'ip': '192.168.1.71',
 *         'port': 1743,
 *         'user': 'kdeconnect',
 *         'password': 'UzcNCrI7T668JyxUFjOxQncBPNcO',
 *         'path': '/storage/emulated/0',
 *         'multiPaths': [
 *             '/storage/0000-0000','/storage/0000-0000/DCIM/Camera',
 *             '/storage/emulated/0','/storage/emulated/0/DCIM/Camera'
 *         ],
 *         'pathNames':[
 *             'SD Card', 'Camera Pictures (SD Card)',
 *             'All files','Camera pictures'
 *         ]
 *     }
 * }
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

        this._setup();
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.sftp') {
            this._parseConnectionData(packet);
        }
    }

    /**
     *
     */
    _setup() {
        try {
            // https://bugzilla.gnome.org/show_bug.cgi?id=607706
            //this._mountpoint = GLib.build_filenamev([GLib.get_home_dir(), this.device.name]);
            this._mountpoint = gsconnect.runtimedir + '/' + this.device.id;
            GLib.mkdir_with_parents(this._mountpoint, 448);

            let dir = Gio.File.new_for_path(this._mountpoint);
            let info = dir.query_info('unix::uid,unix::gid', 0, null);
            this._uid = info.get_attribute_uint32('unix::uid').toString();
            this._gid = info.get_attribute_uint32('unix::gid').toString();
        } catch (e) {
            logError(e, this.device.name);
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

        // Directories
        // If 'multiPaths' is present, stack up common path prefixes to use as
        // the remote root to pass to sshfs
        if (packet.body.hasOwnProperty('multiPaths')) {
            let prefix = [];
            let paths = packet.body.multiPaths.map(p => p.split('/'));

            // Find the common prefixes
            for (let dir of paths[0]) {
                if (paths.every(path => path[0] === dir)) {
                    prefix.push(dir);
                    paths = paths.map(path => path.slice(1));
                } else {
                    break;
                }
            }

            // Rejoin the prefix and multiPaths
            this._root = prefix.join('/');
            paths = paths.map(path => '/' + path.join('/'));

            // Set the directories
            for (let i = 0; i < paths.length; i++) {
                let name = packet.body.pathNames[i];
                this._directories[name] = this._mountpoint + paths[i];
            }

            // The kdeconnect-kde way
//            this._root = '/';

//            for (let i = 0; i < packet.body.multiPaths.length; i++) {
//                let name = packet.body.pathNames[i];
//                let path = packet.body.multiPaths[i];
//                this._directories[name] = this._mountpoint + path;
//            }
        // If 'multiPaths' is missing, just use 'path' and assume there's a
        // a Camera folder. See also:
        //     https://github.com/KDE/kdeconnect-android/blob/master/src/org/kde/kdeconnect/Helpers/StorageHelper.java#L62
        //     https://github.com/KDE/kdeconnect-kde/blob/master/plugins/sftp/sftpplugin.cpp#L128
        } else {
            this._root = packet.body.path;
            this._directories[_('All files')] = this._mountpoint;
            this._directories[_('Camera pictures')] =  this._mountpoint + '/DCIM/Camera';
        }

        this._mount(packet);
    }

    /**
     * Start the sshfs process and send the password
     */
    _sshfs() {
        let args = [
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
            // ssh-dss (DSA) keys are deprecated since openssh-7.0p1
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

        // Only open stdout/stderr if in debug mode
        let flags = Gio.SubprocessFlags.STDIN_PIPE;

        if (gsconnect.settings.get_boolean('debug')) {
            flags |= Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE;
        }

        // Execute sshfs
        this._proc = new Gio.Subprocess({
            argv: args,
            flags: flags
        });
        this._proc.init(null);

        // Cleanup when the process exits
        this._proc.wait_async(null, this._sshfs_finish.bind(this));

        // Print output to log if the pipes are open (debug enabled)
        if (flags & Gio.SubprocessFlags.STDOUT_PIPE) {
            let stdout = new Gio.DataInputStream({
                base_stream: this._proc.get_stdout_pipe()
            });
            this._read_output(stdout);
        }

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

    _read_output(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                debug(stream.read_line_finish(res)[0].toString());
                this._read_output(stream);
            } catch (e) {
                try {
                    stream.close(null);
                } catch (e) {
                    debug(e);
                }
            }
        });
    }

    /**
     * Replace the 'Mount' item with a submenu of directories
     */
    _addSubmenu() {
        // Directory Submenu
        let foldersSubmenu = new Gio.Menu();

        // Directories Section
        let dirSection = new Gio.Menu();

        for (let [name, path] of Object.entries(this._directories)) {
            dirSection.append(name, `device.viewFolder::${path}`);
        }
        foldersSubmenu.append_section(null, dirSection);

        // Unmount Section & Item
        let unmountSection = new Gio.Menu();
        let unmountItem = new Gio.MenuItem();
        unmountItem.set_icon(
            new Gio.ThemedIcon({ name: 'media-eject-symbolic' })
        );
        unmountItem.set_label(_('Unmount'));
        unmountItem.set_detailed_action('device.unmount');
        unmountSection.append_item(unmountItem);
        foldersSubmenu.append_section(null, unmountSection);

        // Directories Item
        let foldersIcon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({ name: 'folder-remote-symbolic' })
        });
        let emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({ name: 'emblem-default' })
        });
        foldersIcon.add_emblem(emblem);

        let foldersItem = new Gio.MenuItem();
        foldersItem.set_icon(foldersIcon);
        foldersItem.set_label(_('List Folders'));
        foldersItem.set_submenu(foldersSubmenu);

        this.device.menu.replace_action('device.mount', foldersItem);
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
        // If mounting is already in progress, let that fail before retrying
        if (this._mounting) {
            return;
        }

        try {
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

