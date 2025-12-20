// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Plugin from '../plugin.js';
import {safe_dirname} from '../utils/file.js';


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
        this._directories = {};
        this._device_dir = null;
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
            const host = this.device.channel.host;

            const regex = new RegExp(
                `sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`
            );

            for (const mount of this._volumeMonitor.get_mounts()) {
                const uri = mount.get_root().get_uri();

                if (regex.test(uri)) {
                    this._gmount = mount;
                    this._addSubmenu(mount);
                    this._addSymlinks(mount, this._directories);

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
            if (this.settings.get_boolean('automount')) {
                debug(
                    `Initial SFTP automount for ${this.device.name}`);
                this.mount();
            }
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

        const host = this.device.channel.host;
        const regex = new RegExp(`sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`);
        const uri = mount.get_root().get_uri();

        if (!regex.test(uri))
            return;

        debug(`Found new SFTP mount for ${this.device.name}`);
        this._gmount = mount;
        this._addSubmenu(mount);
        this._addSymlinks(mount, this._directories);
    }

    _onMountRemoved(monitor, mount) {
        if (this.gmount !== mount)
            return;

        debug(`Mount for ${this.device.name} removed, cleaning up`);
        this._gmount = null;
        this._removeSubmenu();
        this._cleanupDirectories();
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
            const op = new Gio.MountOperation({
                username: packet.body.user || null,
                password: packet.body.password || null,
                password_save: Gio.PasswordSave.NEVER,
            });

            op.connect('ask-question', this._onAskQuestion);
            op.connect('ask-password', this._onAskPassword);

            const host = this.device.channel.host;
            const uri = `sftp://${host}:${packet.body.port}/`;
            const file = Gio.File.new_for_uri(uri);

            const _directories = {};
            for (let i = 0; i < packet.body.multiPaths.length; ++i) {
                try {
                    const _name = packet.body.pathNames[i];
                    const _dir = packet.body.multiPaths[i];
                    _directories[_name] = _dir;
                } catch {}
            }
            this._directories = _directories;
            debug(`Directories: ${Object.entries(this._directories)}`);

            debug(`Mounting ${this.device.name} SFTP server as ${uri}`);
            // This is the actual call to mount the device
            await file.mount_enclosing_volume(GLib.PRIORITY_DEFAULT, op,
                this.cancellable);
        } catch (e) {
            // Special case when the GMount didn't unmount properly but is still
            // on the same port and can be reused.
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ALREADY_MOUNTED))
                return;

            // There's a good chance this is a host key verification error;
            // regardless we'll remove the key for security.
            this._removeHostKey(this.device.channel.host);
            logError(e, this.device.name);
        } finally {
            this._mounting = false;
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
            logError(stdout.trim(), this.device.name);
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

    /*
     * Mount menu helpers
     */
    _getUnmountSection() {
        if (this._unmountSection === undefined) {
            this._unmountSection = new Gio.Menu();

            const unmountItem = new Gio.MenuItem();
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

    _addSubmenu(mount) {
        try {

            // Submenu sections
            const dirSection = new Gio.Menu();
            const unmountSection = this._getUnmountSection();

            for (const [name, path] of Object.entries(this._directories)) {
                const uri = `${mount.get_root().get_uri()}${path}`;
                dirSection.append(name, `device.openPath::${uri}`);
            }

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
        debug('Removing device.mount submenu and restoring mount action');
        try {
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
     * Create a symbolic link referring to the device by name
     *
     * @param {Gio.Mount} mount - A GMount to link to
     * @param {object} directories - The name:path mappings for
     *                               the directory symlinks.
     */
    async _addSymlinks(mount, directories) {
        if (!directories)
            return;
        debug(`Building symbolic links for ${this.device.name}`);
        try {
            // Replace path separator with a Unicode lookalike:
            const safe_device_name = safe_dirname(this.device.name);

            const device_dir = Gio.File.new_for_path(
                `${Config.RUNTIMEDIR}/by-name/${safe_device_name}`
            );
            // Check for and remove any existing links or other cruft
            if (device_dir.query_exists(null) &&
                device_dir.query_file_type(
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !==
                Gio.FileType.DIRECTORY) {
                await device_dir.delete_async(
                    GLib.PRIORITY_DEFAULT, this.cancellable);
            }

            try {
                device_dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
            this._device_dir = device_dir;

            const base_path = mount.get_root().get_path();
            for (const [_name, _path] of Object.entries(directories)) {
                const safe_name = safe_dirname(_name);
                const link_target = `${base_path}${_path}`;
                const link = Gio.File.new_for_path(
                    `${device_dir.get_path()}/${safe_name}`);

                // Check for and remove any existing stale link
                try {
                    const link_stat = await link.query_info_async(
                        'standard::symlink-target',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                        GLib.PRIORITY_DEFAULT,
                        this.cancellable);

                    if (link_stat.get_symlink_target() === link_target)
                        continue;

                    await link.delete_async(GLib.PRIORITY_DEFAULT,
                        this.cancellable);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        throw e;
                }

                debug(`Linking '${_name}' to device path ${_path}`);
                link.make_symbolic_link(link_target, this.cancellable);
            }
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Remove the directory symlinks placed in the by-name path for the
     * device.
     */
    async _cleanupDirectories() {
        if (this._device_dir === null || !this._directories)
            return;

        for (const _name of Object.keys(this._directories)) {
            try {
                const safe_name = safe_dirname(_name);

                debug(`Destroying symlink '${safe_name}'`);
                const link = Gio.File.new_for_path(
                    `${this._device_dir.get_path()}/${safe_name}`);
                await link.delete_async(GLib.PRIORITY_DEFAULT, null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    debug(e, this.device.name);
            }
        }
        this._device_dir = null;
        // We don't clean up this._directories here, because a new mount may
        // be created in the future without another packet being received,
        // and we'll need to know the pathnames to re-create.
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
            this._cleanupDirectories();
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
