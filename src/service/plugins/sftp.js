'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;
const Lan = imports.service.backends.lan;
const PluginBase = imports.service.plugin;


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
            outgoing: ['kdeconnect.sftp.request'],
        },
        unmount: {
            label: _('Unmount'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request'],
        },
    },
};


const MAX_MOUNT_DIRS = 12;


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSFTPPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._gmount = null;
        this._mounting = false;

        // A reusable launcher for ssh processes
        this._launcher = new Gio.SubprocessLauncher({
            flags: (Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE),
        });

        // Watch the volume monitor
        this._volumeMonitor = Gio.VolumeMonitor.get();

        this._mountAddedId = this._volumeMonitor.connect(
            'mount-added',
            this._onMountAdded.bind(this)
        );

        this._mountRemovedId = this._volumeMonitor.connect(
            'mount-removed',
            this._onMountRemoved.bind(this)
        );
    }

    get gmount() {
        if (this._gmount === null && this.device.connected) {
            let host = this.device.channel.host;

            let regex = new RegExp(
                `sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`
            );

            for (let mount of this._volumeMonitor.get_mounts()) {
                let uri = mount.get_root().get_uri();

                if (regex.test(uri)) {
                    this._gmount = mount;
                    this._addSubmenu(mount);
                    this._addSymlink(mount);

                    break;
                }
            }
        }

        return this._gmount;
    }

    connected() {
        super.connected();

        // Only enable for Lan connections
        if (this.device.channel instanceof Lan.Channel) {
            if (this.settings.get_boolean('automount'))
                this.mount();
        } else {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sftp':
                if (packet.body.hasOwnProperty('errorMessage'))
                    this._handleError(packet);
                else
                    this._handleMount(packet);

                break;
        }
    }

    _onMountAdded(monitor, mount) {
        if (this._gmount !== null || !this.device.connected)
            return;

        let host = this.device.channel.host;
        let regex = new RegExp(`sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`);
        let uri = mount.get_root().get_uri();

        if (!regex.test(uri))
            return;

        this._gmount = mount;
        this._addSubmenu(mount);
        this._addSymlink(mount);
    }

    _onMountRemoved(monitor, mount) {
        if (this.gmount !== mount)
            return;

        this._gmount = null;
        this._removeSubmenu();
    }

    async _listDirectories(mount) {
        const file = mount.get_root();

        const iter = await new Promise((resolve, reject) => {
            file.enumerate_children_async(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (file, res) => {
                    try {
                        resolve(file.enumerate_children_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        const infos = await new Promise((resolve, reject) => {
            iter.next_files_async(
                MAX_MOUNT_DIRS,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (iter, res) => {
                    try {
                        resolve(iter.next_files_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        iter.close_async(GLib.PRIORITY_DEFAULT, null, null);

        const directories = {};

        for (const info of infos) {
            const name = info.get_name();
            directories[name] = `${file.get_uri()}${name}/`;
        }

        return directories;
    }

    _onAskQuestion(op, message, choices) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    _onAskPassword(op, message, user, domain, flags) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    /**
     * Handle an error reported by the remote device.
     *
     * @param {Core.Packet} packet - a `kdeconnect.sftp`
     */
    _handleError(packet) {
        this.device.showNotification({
            id: 'sftp-error',
            title: _('%s reported an error').format(this.device.name),
            body: packet.body.errorMessage,
            icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
            priority: Gio.NotificationPriority.HIGH,
        });
    }

    /**
     * Mount the remote device using the provided information.
     *
     * @param {Core.Packet} packet - a `kdeconnect.sftp`
     */
    async _handleMount(packet) {
        try {
            // Already mounted or mounting
            if (this.gmount !== null || this._mounting)
                return;

            this._mounting = true;

            // Ensure the private key is in the keyring
            await this._addPrivateKey();

            // Create a new mount operation
            let op = new Gio.MountOperation({
                username: packet.body.user || null,
                password: packet.body.password || null,
                password_save: Gio.PasswordSave.NEVER,
            });

            op.connect('ask-question', this._onAskQuestion);
            op.connect('ask-password', this._onAskPassword);

            // This is the actual call to mount the device
            let host = this.device.channel.host;
            let uri = `sftp://${host}:${packet.body.port}/`;
            let file = Gio.File.new_for_uri(uri);

            await new Promise((resolve, reject) => {
                file.mount_enclosing_volume(0, op, null, (file, res) => {
                    try {
                        resolve(file.mount_enclosing_volume_finish(res));
                    } catch (e) {
                        // Special case when the GMount didn't unmount properly
                        // but is still on the same port and can be reused.
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ALREADY_MOUNTED)) {
                            resolve(true);

                        // There's a good chance this is a host key verification
                        // error; regardless we'll remove the key for security.
                        } else {
                            this._removeHostKey(host);
                            reject(e);
                        }
                    }
                });
            });
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this._mounting = false;
        }
    }

    /**
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     *
     * @return {Promise} A promise for the operation
     */
    _addPrivateKey() {
        let ssh_add = this._launcher.spawnv([
            Config.SSHADD_PATH,
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']),
        ]);

        return new Promise((resolve, reject) => {
            ssh_add.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let result = proc.communicate_utf8_finish(res)[1].trim();

                    if (proc.get_exit_status() !== 0)
                        debug(result, this.device.name);

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
                    Config.SSHKEYGEN_PATH,
                    '-R',
                    `[${host}]:${port}`,
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
                debug(e, this.device.name);
            }
        }
    }

    /*
     * Mount menu helpers
     */
    _getUnmountSection() {
        if (this._unmountSection === undefined) {
            this._unmountSection = new Gio.Menu();

            let unmountItem = new Gio.MenuItem();
            unmountItem.set_label(Metadata.actions.unmount.label);
            unmountItem.set_icon(new Gio.ThemedIcon({
                name: Metadata.actions.unmount.icon_name,
            }));
            unmountItem.set_detailed_action('device.unmount');
            this._unmountSection.append_item(unmountItem);
        }

        return this._unmountSection;
    }

    _getFilesMenuItem() {
        if (this._filesMenuItem === undefined) {
            // Files menu icon
            const emblem = new Gio.Emblem({
                icon: new Gio.ThemedIcon({name: 'emblem-default'}),
            });

            const mountedIcon = new Gio.EmblemedIcon({
                gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'}),
            });
            mountedIcon.add_emblem(emblem);

            // Files menu item
            this._filesMenuItem = new Gio.MenuItem();
            this._filesMenuItem.set_detailed_action('device.mount');
            this._filesMenuItem.set_icon(mountedIcon);
            this._filesMenuItem.set_label(_('Files'));
        }

        return this._filesMenuItem;
    }

    async _addSubmenu(mount) {
        try {
            const directories = await this._listDirectories(mount);

            // Submenu sections
            const dirSection = new Gio.Menu();
            const unmountSection = this._getUnmountSection();

            for (let [name, uri] of Object.entries(directories))
                dirSection.append(name, `device.openPath::${uri}`);

            // Files submenu
            const filesSubmenu = new Gio.Menu();
            filesSubmenu.append_section(null, dirSection);
            filesSubmenu.append_section(null, unmountSection);

            // Files menu item
            const filesMenuItem = this._getFilesMenuItem();
            filesMenuItem.set_submenu(filesSubmenu);

            // Replace the existing menu item
            const index = this.device.removeMenuAction('device.mount');
            this.device.addMenuItem(filesMenuItem, index);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            // Reset to allow retrying
            this._gmount = null;
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
            logError(e, this.device.name);
        }
    }

    /**
     * Create a symbolic link referring to the device by name
     *
     * @param {Gio.Mount} mount - A GMount to link to
     */
    async _addSymlink(mount) {
        try {
            let by_name_dir = Gio.File.new_for_path(
                `${Config.RUNTIMEDIR}/by-name/`
            );

            try {
                by_name_dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }

            // Replace path separator with a Unicode lookalike:
            let safe_device_name = this.device.name.replace('/', '∕');

            if (safe_device_name === '.')
                safe_device_name = '·';
            else if (safe_device_name === '..')
                safe_device_name = '··';

            let link_target = mount.get_root().get_path();
            let link = Gio.File.new_for_path(
                `${by_name_dir.get_path()}/${safe_device_name}`
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
                        }
                    );
                });

                if (link_stat.get_symlink_target() === link_target)
                    return;

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
                        }
                    );
                });
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw e;
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
        if (this.gmount !== null)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.sftp.request',
            body: {
                startBrowsing: true,
            },
        });
    }

    /**
     * Remove the menu items, unmount the filesystem, replace the mount item
     */
    async unmount() {
        try {
            if (this.gmount === null)
                return;

            this._removeSubmenu();
            this._mounting = false;

            await new Promise((resolve, reject) => {
                this.gmount.unmount_with_operation(
                    Gio.MountUnmountFlags.FORCE,
                    new Gio.MountOperation(),
                    null,
                    (mount, res) => {
                        try {
                            resolve(mount.unmount_with_operation_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    destroy() {
        if (this._volumeMonitor) {
            this._volumeMonitor.disconnect(this._mountAddedId);
            this._volumeMonitor.disconnect(this._mountRemovedId);
            this._volumeMonitor = null;
        }

        super.destroy();
    }
});

