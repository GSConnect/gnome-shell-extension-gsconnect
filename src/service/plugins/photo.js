'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Photo'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Photo',
    incomingCapabilities: ['kdeconnect.photo', 'kdeconnect.photo.request'],
    outgoingCapabilities: ['kdeconnect.photo', 'kdeconnect.photo.request'],
    actions: {
        photo: {
            label: _('Photo'),
            icon_name: 'camera-photo-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.photo'],
            outgoing: ['kdeconnect.photo.request']
        }
    }
};


/**
 * Photo Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/photo
 *
 * TODO: use Cheese?
 *       check for /dev/video*
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPhotoPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'photo');

        // A reusable launcher for silence procs
        this._launcher = new Gio.SubprocessLauncher({
            flags: (Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_SILENCE)
        });
    }

    get camera() {
        return this.settings.get_boolean('share-camera');
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.photo.request' && this.camera) {
            this._sendPhoto();
        } else if (packet.type === 'kdeconnect.photo') {
            this._receivePhoto(packet);
        }
    }

    _ensureReceiveDirectory() {
        let receiveDir = this.settings.get_string('receive-directory');

        // Ensure a directory is set
        if (!receiveDir) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_PICTURES
            );

            // Fallback to ~/Pictures
            let homeDir = GLib.get_home_dir();

            if (!receiveDir || receiveDir === homeDir) {
                receiveDir = GLib.build_filenamev([homeDir, 'Pictures']);
            }

            this.settings.set_string('receive-directory', receiveDir);
        }

        // Ensure the directory exists
        if (!GLib.file_test(receiveDir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(receiveDir, 448);
        }

        return receiveDir;
    }

    _getFile(filename) {
        let dirpath = this._ensureReceiveDirectory();
        let basepath = GLib.build_filenamev([dirpath, filename]);
        let filepath = basepath;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = `${basepath} (${copyNum})`;
        }

        return Gio.File.new_for_path(filepath);
    }

    async _receivePhoto(packet) {
        let file, stream, success, transfer;

        try {
            // Remote device cancelled the photo operation
            if (packet.body.cancel) return;

            file = this._getFile(packet.body.filename);

            stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 0, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            transfer = this.device.createTransfer(Object.assign({
                output_stream: stream,
                size: packet.payloadSize
            }, packet.payloadTransferInfo));

            // Start transfer
            success = await transfer.download(packet.payloadTransferInfo.port);

            // Open the photo on success
            if (success) {
                let uri = file.get_uri();
                Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);

            // Clean up the downloaded file on failure
            } else {
                file.delete(null);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Take a photo using the Webcam, return a file path
     */
    _takePhoto() {
        return new Promise((resolve, reject) => {
            let time = GLib.DateTime.new_now_local().format('%T');
            let path = GLib.build_filenamev([GLib.get_tmp_dir(), `${time}.jpg`]);
            let proc = this._launcher.spawnv([
                gsconnect.metadata.bin.ffmpeg,
                '-f', 'video4linux2',
                '-ss', '0:0:2',
                '-i', '/dev/video0',
                '-frames', '1',
                path
            ]);

            proc.wait_check_async(null, (proc, res) => {
                try {
                    proc.wait_check_finish(res);
                    resolve(path);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _sendPhoto() {
        let file, path, stream, transfer;

        try {
            path = await this._takePhoto();

            if (path.startsWith('file://')) {
                file = Gio.File.new_for_uri(path);
            } else {
                file = Gio.File.new_for_path(path);
            }

            stream = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                    try {
                        resolve(file.read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            transfer = this.device.createTransfer({
                input_stream: stream,
                size: file.query_info('standard::size', 0, null).get_size()
            });

            await transfer.upload({
                type: 'kdeconnect.photo',
                body: {
                    filename: file.get_basename()
                }
            });
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    photo() {
        this.device.sendPacket({
            type: 'kdeconnect.photo.request',
            body: {}
        });
    }
});

