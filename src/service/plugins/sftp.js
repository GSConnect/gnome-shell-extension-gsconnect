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

        this._directories = {};
        this._gmount = null;
        this._mounting = false;
    }

    get ip() {
        // Always use the IP from the current connection
        return this.device.settings.get_string('tcp-host');
    }

    handlePacket(packet) {
        // Ensure we don't mount on top of an existing mount
        if (packet.type === 'kdeconnect.sftp' && this._gmount === null) {
            this._mount(packet.body);
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
     * Setup the directories for export with GMenu and store the mountpoint.
     *
     * @param {object} info - The body of a kdeconnect.sftp packet
     */
    async _setup(info) {
        try {
            this._user = info.user;
            this._password = info.password;
            this._port = info.port;
            this._uri = `sftp://${this.ip}:${this._port}/`;

            // HACK: Test an SFTP mount for this IP in the 1716-1764 range
            this._uriRegex = new RegExp(`sftp://(${this.ip}):(171[6-9]|17[2-5][0-9]|176[0-4])`);

            // Ensure the private key is in the keyring
            await this._add_identity();

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

            return Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async _mount(info) {
        try {
            // If mounting is already in progress, let that fail before retrying
            if (this._mounting) return;
            this._mounting = true;

            await this._setup(info);

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
                        // Special case when the GMount didn't unmount properly
                        // but is still on the same port and can be reused.
                        if (e.code && e.code === Gio.IOErrorEnum.ALREADY_MOUNTED) {
                            warning(e, `${this.device.name} (${this.name})`);
                            resolve(true);

                        // There's a good chance this is a host key verification
                        // error; regardless we'll remove the key for security.
                        } else {
                            this._remove_host(this._port);
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
                    this._gmount = mount;
                    this._gmount.connect('unmounted', this.unmount.bind(this));

                // Or if it's a stale mount we need to cleanup
                } else if (this._uriRegex.test(uri)) {
                    warning('Removing stale GMount', `${this.device.name} (${this.name})`);
                    await this._unmount(mount);
                }
            }

            // Populate the menu
            this._addSubmenu();
            this._mounting = false;
        } catch (e) {
            logError(e, `${this.device.name} (${this.name})`);
            this._mounting = false;
            this.unmount();
        }
    }

    _unmount(mount) {
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
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     */
    _add_identity() {
        let ssh_add = this._launcher.spawnv([
            gsconnect.metadata.bin.ssh_add,
            GLib.build_filenamev([gsconnect.configdir, 'private.pem'])
        ]);

        return new Promise((resolve, reject) => {
            ssh_add.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let result = proc.communicate_utf8_finish(res)[1].trim();

                    if (proc.get_exit_status() !== 0) {
                        warning(result, `${this.device.name} (${this.name})`);
                    }

                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Remove old host keys from ~/.ssh/known_hosts for this host from the range
     * used by KDE Connect (1739-1764).
     *
     * @param {number} port - The port to remove the host key for
     */
    async _remove_host(port = 1739) {
        try {
            let ssh_keygen = this._launcher.spawnv([
                gsconnect.metadata.bin.ssh_keygen,
                '-R',
                `[${this.ip}]:${port}`
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

            debug(`removed host key for [${this.ip}]:${port}`);
        } catch (e) {
            warning(e, `${this.device.name} (${this.name})`);
        }
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
            // Skip since this will always fail
            if (this._gmount) {
                await this._unmount(this._gmount);
            }
        } catch (e) {
            debug(e, this.device.name);

        // Always reset the state and menu
        } finally {
            this._directories = {};
            this._gmount = null;
            this._mounting = false;
            this._removeSubmenu();
        }
    }

    destroy() {
        this.unmount();
        super.destroy();
    }
});

