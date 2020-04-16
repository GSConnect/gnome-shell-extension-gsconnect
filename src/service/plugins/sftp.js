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

        // A reusable launcher for ssh processes
        this._launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
        });

        this._mounting = false;
    }

    get info() {
        if (this._info === undefined) {
            this._info = {
                directories: {},
                mount: null,
                regex: null,
                uri: null
            };
        }

        return this._info;
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.sftp') {
            // There was an error mounting the filesystem
            if (packet.body.errorMessage) {
                this.device.showNotification({
                    id: 'sftp-error',
                    title: `${this.device.name}: ${Metadata.label}`,
                    body: packet.body.errorMessage,
                    icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
                    priority: Gio.NotificationPriority.URGENT
                });

            // Ensure we don't mount on top of an existing mount
            } else if (this.info.mount === null) {
                this._mount(packet.body);
            }
        }
    }

    connected() {
        super.connected();

        // Disable for all bluetooth connections
        if (this.device.connection_type !== 'lan') {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;

        // Request a mount
        } else {
            this.mount();
        }
    }

    disconnected() {
        super.disconnected();
        this.unmount();
    }

    /**
     * Parse the connection info
     *
     * @param {object} info - The body of a kdeconnect.sftp packet
     */
    _parseInfo(info) {
        if (!this.device.connected) {
            throw new Gio.IOErrorEnum({
                message: _('Device is disconnected'),
                code: Gio.IOErrorEnum.CONNECTION_CLOSED
            });
        }

        this._info = info;
        this.info.ip = this.device.channel.host;
        this.info.directories = {};
        this.info.mount = null;
        this.info.regex = new RegExp(
            'sftp://(' + this.info.ip + '):(1739|17[4-5][0-9]|176[0-4])'
        );
        this.info.uri = 'sftp://' + this.info.ip + ':' + this.info.port + '/';

        // If 'multiPaths' is present setup a local URI for each
        if (info.hasOwnProperty('multiPaths')) {
            for (let i = 0; i < info.multiPaths.length; i++) {
                let name = info.pathNames[i];
                let path = info.multiPaths[i];
                this.info.directories[name] = this.info.uri + path;
            }

        // If 'multiPaths' is missing use 'path' and assume a Camera folder
        } else {
            let uri = this.info.uri + this.info.path;
            this.info.directories[_('All files')] = uri;
            this.info.directories[_('Camera pictures')] = uri + 'DCIM/Camera';
        }
    }

    _onAskQuestion(op, message, choices) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    _onAskPassword(op, message, user, domain, flags) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    async _mount(info) {
        try {
            // If mounting is already in progress, let that fail before retrying
            if (this._mounting) return;
            this._mounting = true;

            // Parse the connection info
            this._parseInfo(info);

            // Ensure the private key is in the keyring
            await this._addPrivateKey();

            // Create a new mount operation
            let op = new Gio.MountOperation({
                username: info.user,
                password: info.password,
                password_save: Gio.PasswordSave.NEVER
            });

            // Auto-accept new host keys and password requests
            let questionId = op.connect('ask-question', this._onAskQuestion);
            let passwordId = op.connect('ask-password', this._onAskPassword);

            // This is the actual call to mount the device
            await new Promise((resolve, reject) => {
                let file = Gio.File.new_for_uri(this.info.uri);

                file.mount_enclosing_volume(0, op, null, (file, res) => {
                    try {
                        op.disconnect(questionId);
                        op.disconnect(passwordId);
                        resolve(file.mount_enclosing_volume_finish(res));
                    } catch (e) {
                        // Special case when the GMount didn't unmount properly
                        // but is still on the same port and can be reused.
                        if (e.code && e.code === Gio.IOErrorEnum.ALREADY_MOUNTED) {
                            resolve(true);

                        // There's a good chance this is a host key verification
                        // error; regardless we'll remove the key for security.
                        } else {
                            this._removeHostKey(this.info.ip);
                            reject(e);
                        }
                    }
                });
            });

            // Get the GMount from GVolumeMonitor
            let monitor = Gio.VolumeMonitor.get();

            for (let mount of monitor.get_mounts()) {
                let uri = mount.get_root().get_uri();

                // This is our GMount
                if (this.info.uri === uri) {
                    this.info.mount = mount;
                    this.info.mount.connect(
                        'unmounted',
                        this.unmount.bind(this)
                    );

                    this._addSymlink(mount);

                // This is one of our old mounts
                } else if (this.info.regex.test(uri)) {
                    debug(`Remove stale mount at ${uri}`);
                    await this._unmount(mount);
                }
            }

            // Populate the menu
            this._addSubmenu();
        } catch (e) {
            logError(e, this.device.name);
            this.unmount();
        } finally {
            this._mounting = false;
        }
    }

    _unmount(mount = null) {
        if (!mount) return Promise.resolve();

        return new Promise((resolve, reject) => {
            let op = new Gio.MountOperation();

            mount.unmount_with_operation(1, op, null, (mount, res) => {
                try {
                    mount.unmount_with_operation_finish(res);
                    resolve();
                } catch (e) {
                    debug(e);
                    resolve();
                }
            });
        });
    }

    /**
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     */
    _addPrivateKey() {
        let ssh_add = this._launcher.spawnv([
            gsconnect.metadata.bin.ssh_add,
            GLib.build_filenamev([gsconnect.configdir, 'private.pem'])
        ]);

        return new Promise((resolve, reject) => {
            ssh_add.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let result = proc.communicate_utf8_finish(res)[1].trim();

                    if (proc.get_exit_status() !== 0) {
                        debug(result, this.device.name);
                    }

                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Remove all host keys from ~/.ssh/known_hosts for @host in the port range
     * used by KDE Connect (1739-1764).
     *
     * @param {string} host - A hostname or IP address
     */
    async _removeHostKey(host) {
        for (let port = 1739; port <= 1764; port++) {
            try {
                let ssh_keygen = this._launcher.spawnv([
                    gsconnect.metadata.bin.ssh_keygen,
                    '-R',
                    `[${host}]:${port}`
                ]);

                await new Promise((resolve, reject) => {
                    ssh_keygen.wait_check_async(null, (proc, res) => {
                        try {
                            resolve(proc.wait_check_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
            } catch (e) {
                debug(e);
            }
        }
    }

    /**
     * Mount menu helpers
     */
    _getUnmountSection() {
        if (this._unmountSection === undefined) {
            this._unmountSection = new Gio.Menu();

            let unmountItem = new Gio.MenuItem();
            unmountItem.set_label(Metadata.actions.unmount.label);
            unmountItem.set_icon(new Gio.ThemedIcon({
                name: Metadata.actions.unmount.icon_name
            }));
            unmountItem.set_detailed_action('device.unmount');
            this._unmountSection.append_item(unmountItem);
        }

        return this._unmountSection;
    }

    _getMountedIcon() {
        if (this._mountedIcon === undefined) {
            this._mountedIcon = new Gio.EmblemedIcon({
                gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'})
            });

            // TODO: this emblem often isn't very visible
            let emblem = new Gio.Emblem({
                icon: new Gio.ThemedIcon({name: 'emblem-default'})
            });

            this._mountedIcon.add_emblem(emblem);
        }

        return this._mountedIcon;
    }

    _addSubmenu() {
        try {
            // Directories Section
            let dirSection = new Gio.Menu();

            for (let [name, uri] of Object.entries(this.info.directories)) {
                dirSection.append(name, `device.openPath::${uri}`);
            }

            // Unmount Section
            let unmountSection = this._getUnmountSection();

            // Files Submenu
            let filesSubmenu = new Gio.Menu();
            filesSubmenu.append_section(null, dirSection);
            filesSubmenu.append_section(null, unmountSection);

            // Files Item
            let filesItem = new Gio.MenuItem();
            filesItem.set_detailed_action('device.mount');
            filesItem.set_icon(this._getMountedIcon());
            filesItem.set_label(_('Files'));
            filesItem.set_submenu(filesSubmenu);

            this.device.replaceMenuAction('device.mount', filesItem);
        } catch (e) {
            logError(e);
        }
    }

    _removeSubmenu() {
        try {
            let index = this.device.removeMenuAction('device.mount');
            let action = this.device.lookup_action('mount');

            if (action !== null) {
                this.device.addMenuAction(
                    action,
                    index,
                    Metadata.actions.mount.label,
                    Metadata.actions.mount.icon_name
                );
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Create a symbolic link referring to the device by name
     */
    async _addSymlink(mount) {
        try {
            let by_name_dir = Gio.File.new_for_path(
                gsconnect.runtimedir + '/by-name/'
            );

            try {
                by_name_dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    throw e;
                }
            }

            // Replace path separator with a Unicode lookalike:
            let safe_device_name = this.device.name.replace('/', '∕');

            if (safe_device_name === '.') {
                safe_device_name = '·';
            } else if (safe_device_name === '..') {
                safe_device_name = '··';
            }

            let link_target = mount.get_root().get_path();
            let link = Gio.File.new_for_path(
                by_name_dir.get_path() + '/' + safe_device_name
            );

            // Check for and remove any existing stale link
            try {
                let link_stat = await new Promise((resolve, reject) => {
                    link.query_info_async(
                        'standard::symlink-target',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (link, res) => {
                            try {
                                resolve(link.query_info_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        },
                    );
                });

                if (link_stat.get_symlink_target() === link_target) {
                    return;
                }

                await new Promise((resolve, reject) => {
                    link.delete_async(
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (link, res) => {
                            try {
                                resolve(link.delete_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        },
                    );
                });
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    throw e;
                }
            }

            link.make_symbolic_link(link_target, null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        this.device.sendPacket({
            type: 'kdeconnect.sftp.request',
            body: {
                startBrowsing: true
            }
        });
    }

    /**
     * Remove the menu items, unmount the filesystem, replace the mount item
     */
    async unmount() {
        try {
            if (this.info.mount === null) {
                return;
            }

            let mount = this.info.mount;

            this._removeSubmenu();
            this._info = undefined;
            this._mounting = false;

            await this._unmount(mount);
        } catch (e) {
            debug(e);
        }
    }

    destroy() {
        this.unmount();
        super.destroy();
    }
});

