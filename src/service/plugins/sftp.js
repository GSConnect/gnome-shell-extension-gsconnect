// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import Plugin from '../plugin.js';


export const Metadata = {
    label: _('SFTP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    description: _('Browse the paired device filesystem'),
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


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
const SFTPPlugin = GObject.registerClass({
    GTypeName: 'GSConnectSFTPPlugin',
}, class SFTPPlugin extends Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._gmount = null;
        this._mounting = false;

        // Stores multiPaths/pathNames from the device packet.
        this._remoteDirectories = null;

        // Track if the mount was requested by user interaction (clicking Mount)
        this._userRequested = false;

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
            const host = this.device.channel.host;

            // The URI can include a path like /storage/emulated/0
            const regex = new RegExp(
                `^sftp://${host.replace(/\./g, '\\.')}:(1739|17[4-5][0-9]|176[0-4])(/|$)`
            );

            for (const mount of this._volumeMonitor.get_mounts()) {
                const uri = mount.get_root().get_uri();

                if (regex.test(uri)) {
                    this._gmount = mount;
                    // Only add submenu if we're not currently mounting thus we're waiting for the packet with the multiPaths
                    if (!this._mounting)
                        this._addSubmenu(mount);

                    break;
                }
            }
        }

        return this._gmount;
    }

    connected() {
        super.connected();

        // Only enable for Lan connections
        if (this.device.channel.constructor.name === 'LanChannel') { // FIXME: Circular import workaround
            if (this.settings.get_boolean('automount'))
                this.mount(false);  // Automount without opening directory
        } else {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sftp':
                if (packet.body.hasOwnProperty('errorMessage')) {
                    this._handleError(packet);
                } else {
                    this._handleMount(packet).catch(e => {
                        log(`GSConnect SFTP [${this.device.name}]: Unhandled error in _handleMount`);
                        logError(e, this.device.name);
                    });
                }
                break;
        }
    }

    _onMountAdded(monitor, mount) {
        if (this._gmount !== null || !this.device.connected)
            return;

        const host = this.device.channel.host;
        const regex = new RegExp(`^sftp://${host.replace(/\./g, '\\.')}:(1739|17[4-5][0-9]|176[0-4])(/|$)`);
        const uri = mount.get_root().get_uri();

        if (!regex.test(uri))
            return;

        this._gmount = mount;
        this._addSubmenu(mount);

        if (this._userRequested) {
            this._userRequested = false;
            this._openDirectory(mount);
        }
    }

    _onMountRemoved(monitor, mount) {
        if (this.gmount !== mount)
            return;

        this._gmount = null;
        this._remoteDirectories = null;
        this._mounting = false;
        this._removeSubmenu();
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
        const host = this.device.channel.host;
        let uri = `sftp://${host}:${packet.body.port}/`;

        try {
            // Storing multiPaths information from the packet first
            this._remoteDirectories = null;
            if (packet.body.hasOwnProperty('multiPaths') &&
                packet.body.hasOwnProperty('pathNames')) {
                const paths = packet.body.multiPaths;
                const names = packet.body.pathNames;
                const size = Math.min(paths.length, names.length);

                if (size > 0) {
                    this._remoteDirectories = {};
                    for (let i = 0; i < size; i++)
                        this._remoteDirectories[names[i]] = paths[i];
                }
            }

            // We're just updating the submenu if we're already mounted
            if (this._gmount !== null) {
                await this._addSubmenu(this._gmount);
                if (this._userRequested) {
                    this._userRequested = false;
                    this._openDirectory(this._gmount);
                }
                return;
            }

            // Check for existing mount in volume monitor that we have not tracked yet
            const regex = new RegExp(`^sftp://${host.replace(/\./g, '\\.')}:(1739|17[4-5][0-9]|176[0-4])(/|$)`);
            for (const mount of this._volumeMonitor.get_mounts()) {
                const mountUri = mount.get_root().get_uri();
                if (regex.test(mountUri)) {
                    this._gmount = mount;
                    await this._addSubmenu(mount);
                    if (this._userRequested) {
                        this._userRequested = false;
                        this._openDirectory(mount);
                    }
                    return;
                }
            }

            if (this._mounting) {
                // _userRequested was already set in mount()
                // so when mount completes _onMountAdded will open the directory
                return;
            }

            this._mounting = true;

            // Ensure the private key is in the keyring
            await this._addPrivateKey();

            // Create a new mount operation
            const op = new Gio.MountOperation({
                username: packet.body.user || null,
                password: packet.body.password || null,
                password_save: Gio.PasswordSave.NEVER,
            });

            op.connect('ask-question', this._onAskQuestion);
            op.connect('ask-password', this._onAskPassword);

            // Mount to the SFTP root. Deep path mounting (e.g., /storage/emulated/0)
            // fails with "Connection failed"
            // uri = `sftp://${host}:${packet.body.port}/storage/emulated/0`;
            // It looks to me that this is about the following bug in GVfs:
            // https://gitlab.gnome.org/GNOME/gvfs/-/issues/625#note_1448225
            uri = `sftp://${host}:${packet.body.port}/`;
            const file = Gio.File.new_for_uri(uri);

            await file.mount_enclosing_volume(GLib.PRIORITY_DEFAULT, op,
                this.cancellable);
        } catch (e) {
            // Special case when the GMount didn't unmount properly but is still
            // on the same port and can be reused, or when we get a permission error
            // because the mount already exists.
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ALREADY_MOUNTED) ||
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)) {
                // Try to find and use the existing mount
                const regex = new RegExp(`^sftp://${host.replace(/\./g, '\\.')}:(1739|17[4-5][0-9]|176[0-4])(/|$)`);
                for (const mount of this._volumeMonitor.get_mounts()) {
                    const mountUri = mount.get_root().get_uri();
                    if (regex.test(mountUri)) {
                        this._gmount = mount;
                        await this._addSubmenu(mount);
                        if (this._userRequested)
                            this._openDirectory(mount);
                        return;
                    }
                }
                return;
            }

            // There's a good chance this is a host key verification error;
            // regardless we'll remove the key for security.
            this._removeHostKey(host);
        } finally {
            this._mounting = false;
            // Don't reset _userRequested here - it will be reset in _onMountAdded
            // after opening the directory (if requested)
        }
    }

    /**
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     *
     * @returns {Promise} A promise for the operation
     */
    async _addPrivateKey() {
        const ssh_add = this._launcher.spawnv([
            Config.SSHADD_PATH,
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']),
        ]);

        const [stdout] = await ssh_add.communicate_utf8_async(null,
            this.cancellable);

        if (ssh_add.get_exit_status() !== 0)
            logError(new Error(stdout.trim()), this.device.name);
    }

    /**
     * Remove all host keys from ~/.ssh/known_hosts for {@link host} in the
     * port range used by KDE Connect (1739-1764).
     *
     * @param {string} host - A hostname or IP address
     */
    async _removeHostKey(host) {
        for (let port = 1739; port <= 1764; port++) {
            try {
                const ssh_keygen = this._launcher.spawnv([
                    Config.SSHKEYGEN_PATH,
                    '-R',
                    `[${host}]:${port}`,
                ]);

                const [stdout] = await ssh_keygen.communicate_utf8_async(null,
                    this.cancellable);

                const status = ssh_keygen.get_exit_status();

                if (status !== 0) {
                    throw new Gio.IOErrorEnum({
                        code: Gio.io_error_from_errno(status),
                        message: `${GLib.strerror(status)}\n${stdout}`.trim(),
                    });
                }
            } catch (e) {
                logError(e, this.device.name);
            }
        }
    }

    _createFilesMenuItem() {
        // Files menu icon
        const emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({name: 'emblem-default'}),
        });

        const mountedIcon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'}),
        });
        mountedIcon.add_emblem(emblem);

        // Files menu item
        const filesMenuItem = new Gio.MenuItem();
        filesMenuItem.set_detailed_action('device.mount');
        filesMenuItem.set_icon(mountedIcon);
        filesMenuItem.set_label(_('Files'));

        return filesMenuItem;
    }

    /**
     * Open the primary accessible directory in the file browser.
     *
     * @param {Gio.Mount} mount - The GMount to open
     */
    _openDirectory(mount) {
        const baseUri = mount.get_root().get_uri();

        // Open via SFTP URI directly - faster than going through symlinks
        if (this._remoteDirectories !== null) {
            const entries = Object.entries(this._remoteDirectories);
            if (entries.length > 0) {
                const [name, path] = entries[0];
                Gio.AppInfo.launch_default_for_uri_async(
                    `${baseUri}${path.replace(/^\//, '')}/`, null, null, null);
                return;
            }
        }

        // Fallback: open mount root
        Gio.AppInfo.launch_default_for_uri_async(baseUri, null, null, null);
    }

    /**
     * Replace the Mount menu item with Files and Unmount items when mounted.
     *
     * @param {Gio.Mount} mount - The GMount
     */
    async _addSubmenu(mount) {
        try {
            const filesMenuItem = this._createFilesMenuItem();

            // Replace Mount with Files
            const index = this.device.removeMenuAction('device.mount');
            this.device.addMenuItem(filesMenuItem, index);

            // Add Unmount after Files
            const unmountAction = this.device.lookup_action('unmount');
            if (unmountAction !== null) {
                this.device.addMenuAction(
                    unmountAction,
                    index + 1,
                    Metadata.actions.unmount.label,
                    Metadata.actions.unmount.icon_name
                );
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, `${this.device.name}: Error building menu`);

            // Reset to allow retrying
            this._gmount = null;
        }
    }

    _removeSubmenu() {
        try {
            // Remove Unmount menu item
            this.device.removeMenuAction('device.unmount');

            // Replace Files with Mount
            const index = this.device.removeMenuAction('device.mount');
            const action = this.device.lookup_action('mount');

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
     * Send a request to mount the remote device
     *
     * @param {boolean} [openDirectory=true] - Whether to open the directory after mounting
     */
    mount(openDirectory) {
        // Default to true if not explicitly set to false
        // action activation passes null so we can't use default parameter
        const shouldOpen = openDirectory !== false;

        // If already mounted and user wants to open, open immediately
        if (this._gmount !== null && shouldOpen) {
            this._openDirectory(this._gmount);
            return;
        }

        // Mark this as a user-requested mount so we know to open the directory
        // Only open if explicitly requested (not for automount)
        this._userRequested = shouldOpen;

        // Reset mounting flag to allow fresh mount attempt
        this._mounting = false;

        // Request SFTP info from the phone to get multiPaths and mount.
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

            await this.gmount.unmount_with_operation(
                Gio.MountUnmountFlags.FORCE,
                new Gio.MountOperation(),
                this.cancellable);
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

export default SFTPPlugin;
