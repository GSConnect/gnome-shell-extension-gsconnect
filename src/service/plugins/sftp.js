'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
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
            outgoing: ['kdeconnect.sftp.request'],
            allow: 6
        },
        unmount: {
            summary: _('Unmount'),
            description: _('Unmount a remote device'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request'],
            allow: 6
        }
    },
    events: {}
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

        if (this.device._channel.type === 'bluetooth') {
            this.destroy();
            throw Error(_('Can\'t run on bluetooth connection'));
        }

        if (!gsconnect.checkCommand('sshfs')) {
            this.destroy();
            throw Error(_('SSHFS not installed'));
        }

        this._setup();
    }

    handlePacket(packet) {
        debug(packet);

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
            debug(e);
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

        // FIXME: shouldn't automount, but should auto-probe for info
        this._mount(packet);
    }

    /**
     * Start the sshfs process and send the password
     */
    _sshfsExec() {
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
            // Sketchy?
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
            // Automatically reconnect to server if connection is interrupted
            '-o', 'reconnect',
            // Set user/group permissions to allow readwrite access
            '-o', `uid=${this._uid}`, '-o', `gid=${this._gid}`,
            // 'read password from stdin (only for pam_mount!)'
            '-o', 'password_stdin'
        ];

        // Execute sshfs
        this._proc = GLib.spawn_async_with_pipes(
            null,                                   // working dir
            args,                                   // argv
            null,                                   // envp
            GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
            null                                    // child_setup (func)
        );

        // Watching stdout/stderr
        this._stdout = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._proc[3] })
        });

        let outsrc = this._stdout.base_stream.create_source(null);
        outsrc.set_callback(() => this._read_stream(this._stdout));
        outsrc.attach(null);

        this._stderr = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._proc[4] })
        });

        let errsrc = this._stderr.base_stream.create_source(null);
        errsrc.set_callback(() => this._read_stream(this._stderr));
        errsrc.attach(null);

        // Send session password
        let stdin = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({
                close_fd: false,
                fd: this._proc[2]
            })
        });
        stdin.put_string(`${this._password}\n`, null);
        stdin.close(null);
    }

    _sshfsKill() {
        try {
            GLib.spawn_command_line_async(`kill -9 ${this._proc[1]}`);
        } catch (e) {
            debug(e);
        }

        this._proc = undefined;

        // Close streams
        for (let stream of [this._stdout, this._stderr]) {
            try {
                stream.close(null);
            } catch (e) {
                debug(e);
            }
        }

        this._stdout = undefined;
        this._stderr = undefined;

        // Make sure it's actually unmounted
        if (this._mountpoint) {
            if (gsconnect.checkCommand('fusermount')) {
                GLib.spawn_command_line_async(`fusermount -uz ${this._mountpoint}`);
            } else {
                GLib.spawn_command_line_async(`umount ${this._mountpoint}`);
            }

            this._mountpoint = undefined;
        }
    }

    _read_stream(stream) {
        if (!stream) {
            return GLib.SOURCE_REMOVE;
        }

        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            let [data, len] = source.read_line_finish(res);

            if (data === null) {
                debug('sshfs: stream closed');
                this.unmount();
            } else {
                debug(data.toString());
            }
        });

        return GLib.SOURCE_CONTINUE;
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

        this.device.menu.replace_action('mount', foldersItem);
    }

    /**
     * Run sshfs and replace the
     */
    _mount() {
        // If mounting is already in progress, but we received a new browse
        // packet, we should probably unmount and start over
        if (this._mounting) {
            this.unmount();
        }

        this._mounting = true;

        // Start sshfs
        try {
            this._sshfsExec();
        } catch (e) {
            this.unmount();
            logError(e);
            return;
        }

        // Add the directories to the menu
        this._addSubmenu();

        // Set 'mounted'
        this._mounting = false;
        this._mounted = true;
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
     * Remove the menu items, kill sshfs, replace the mount item
     */
    unmount() {
        if (!this._mounted) {
            return;
        }

        // Remove the directories from the menu first
        let itemPosition = this.device.menu.remove_named(_('List Folders'));

        // Stop sshfs
        this._sshfsKill();

        // Reset the directories and 'mounted'
        this._directories = {};
        this._mounted = false;

        // Add the mount item back to the menu
        let mountItem = new Gio.MenuItem();
        mountItem.set_label(_('Mount'));
        mountItem.set_icon(
            new Gio.ThemedIcon({ name: 'folder-remote-symbolic' })
        );
        mountItem.set_detailed_action('device.mount');
        this.device.menu.insert_item(itemPosition, mountItem);
    }

    destroy() {
        // This should also ensure that only the 'mount' item is in the menu
        if (this.mounted) {
            this.unmount();
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

