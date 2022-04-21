'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const {BluetoothHandoffDialog} = imports.service.ui.bluetoothHandoff;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Bluetooth Handoff'),
    description: _('Share Bluetooth devices'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.BluetoothHandoff',
    incomingCapabilities: [
        'kdeconnect.bluetooth_handoff.device_list',
        'kdeconnect.bluetooth_handoff.disconnect.response',
    ],
    outgoingCapabilities: [
        'kdeconnect.bluetooth_handoff.device_list.request',
        'kdeconnect.bluetooth_handoff.disconnect.request',
    ],
    actions: {
        openBluetoothHandoffDialog: {
            label: _('Bluetooth Devices'),
            icon_name: 'bluetooth-active-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.bluetooth_handoff.device_list.request'],
        },
    },
};

// TODO: Remove me
function log(message) {
    GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
        'MESSAGE': message,
        'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect.BluetoothHandoff'
    });
}


/**
 * Bluetooth Handoff Plugin
 * https://invent.kde.org/network/kdeconnect-kde/-/tree/master/plugins/bluetooth-handoff
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothHandoffPlugin',
    Signals: {
        'combined-state-changed': {},
    },
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'bluetooth_handoff');

        this.local_devs_state = [];
        this.remote_devs_state = [];
        this.combined_devs_state = [];
        this.combined_devs_state_json = "[]";
        this._bluez = null;
        this._bluezId = 0;

        this._devicePollCancelable = new Gio.Cancellable();
    }

    connected() {
        log('Connected');
        super.connected();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.bluetooth_handoff.device_list':
                this._receiveRemoteState(packet);
                break;
            case 'kdeconnect.bluetooth_handoff.disconnect.response':
                log('Disconnected: ' + JSON.stringify(packet.body));
        }
    }

    openBluetoothHandoffDialog() {
        log('Open dialog');
        if (this._dialog === undefined) {
            this._dialog = new BluetoothHandoffDialog({
                device: this.device,
                plugin: this,
            }, this._dialogClosedCb.bind(this));
        }

        this._dialog.present();

        // Force update
        this.combined_devs_state_json = "[]";
        this._requestState();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._requestState();

            if (!this._devicePollCancelable.is_cancelled()) {
                return GLib.SOURCE_CONTINUE;
            } else {
                return GLib.SOURCE_REMOVE;
            }
        });

        if (this._bluez === null) {
            this._bluez = Components.acquire('bluez');
            this._bluezId = this._bluez.connect(
                'changed',
                this._receiveLocalState.bind(this)
            );
            this.local_devs_state = this._bluez.local_devices;
        }
    }

    _dialogClosedCb() {
        this._dialog = undefined;
    }

    _receiveLocalState() {
        this.local_devs_state = this._bluez.local_devices;
        this._update_combined_state();
    }

    /**
     * Handle a remote state update.
     *
     * @param {Core.Packet} packet - A kdeconnect.bluetooth_handoff.device_list packet
     */
    _receiveRemoteState(packet) {
        debug('Got device list: ' + JSON.stringify(packet.body));

        // Update combined state
        this.remote_devs_state = packet.body.devices;
        this._update_combined_state();
    }

    /**
     * Request the remote device's connectivity state
     */
    _requestState() {
        debug("Requesting remote device list");
        this.device.sendPacket({
            type: 'kdeconnect.bluetooth_handoff.device_list.request',
            body: {},
        });
    }

    _update_combined_state() {
        debug('--- local:  ' + JSON.stringify(this.local_devs_state));
        debug('--- remote: ' + JSON.stringify(this.remote_devs_state));

        let local_by_mac = {};
        this.local_devs_state.forEach((dev) => {
            local_by_mac[dev.addr] = dev;
        });

        let remote_by_mac = {};
        this.remote_devs_state.forEach((dev) => {
            remote_by_mac[dev.addr] = dev;
        });

        let combined = [];
        Object.keys(local_by_mac).forEach((mac) => {
            let local = local_by_mac[mac];
            let remote = remote_by_mac[mac];
            if (remote === undefined || (remote.connected === false && local.connected === false)) {
                return;
            }

            let name = local.alias;
            if (remote.name != local.alias) {
                name = local.alias + ' (' + remote.name + ')';
            }

            combined.push({
                'addr': mac,
                'name': name,
                'icon': local.icon,
                'local_connected': local.connected,
                'loading': false,
            });
        });

        let combined_json = JSON.stringify(combined);
        if (combined_json !== this.combined_devs_state_json) {
            this.combined_devs_state = combined;
            this.combined_devs_state_json = combined_json;
            this.emit('combined-state-changed');
        }
    }

    takeDevice(address) {
        log('Sent dc req');
        this.device.sendPacket({
            type: 'kdeconnect.bluetooth_handoff.disconnect.request',
            body: {
                "addr": address,
            },
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            (async () => {
                log('Starting local connect');
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.NONE,
                });
                const cancellable = new Gio.Cancellable();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                    cancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });

                for (let i = 0; i < 3; i++) {
                    const proc = launcher.spawnv(['bluetoothctl', 'connect', address]);

                    let success = await new Promise((resolve, reject) => {
                        proc.wait_check_async(cancellable, (proc, res) => {
                            try {
                                proc.wait_check_finish(res);
                                log('Connection successful!');
                                resolve(true);
                            } catch (e) {
                                log('Connection unsuccessful: ' + e);
                                resolve(false);
                            }
                        });
                    });
                    if (success) {
                        break;
                    }
                }
            })();

            return GLib.SOURCE_REMOVE;
        });
    }

    giveDevice(address) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.NONE,
        });
        const cancellable = new Gio.Cancellable();
        const proc = launcher.spawnv(['bluetoothctl', 'disconnect', address]);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });

        proc.wait_check_async(cancellable, (proc, res) => {
            try {
                proc.wait_check_finish(res);
                log('Disconnection successful!');
            } catch (e) {
                log('Disconnection unsuccessful: ' + e);
                return;
            }

            this.device.sendPacket({
                type: 'kdeconnect.bluetooth_handoff.connect.request',
                body: {
                    "addr": address,
                },
            });
        });
    }

    destroy() {
        if (this._dialog !== undefined)
            this._dialog.destroy();

        if (this._bluez !== null) {
            this._bluez.disconnect(this._bluezId);
            this._bluez = Components.release('bluez');
        }

        if (this._devicePollCancelable) {
            this._devicePollCancelable.cancel();
        }

        super.destroy();
    }
});
