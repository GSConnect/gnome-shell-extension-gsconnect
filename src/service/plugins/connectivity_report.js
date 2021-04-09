'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Connectivity Report'),
    description: _('Display connectivity status'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.ConnectivityReport',
    incomingCapabilities: [
        'kdeconnect.connectivity_report',
    ],
    outgoingCapabilities: [
        'kdeconnect.connectivity_report.request',
    ],
    actions: {},
};


/**
 * Connectivity Report Plugin
 * https://invent.kde.org/network/kdeconnect-kde/-/tree/master/plugins/connectivity_report
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectConnectivityReportPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'connectivity_report');

        // Export connectivity state as GAction
        this.__state = new Gio.SimpleAction({
            name: 'connectivityReport',
            // (
            //   cellular_network_type,
            //   cellular_network_type_icon,
            //   cellular_network_strength(0..4),
            //   cellular_network_strength_icon,
            // )
            parameter_type: new GLib.VariantType('(ssis)'),
            state: this.state,
        });
        this.device.add_action(this.__state);
    }

    get signal_strength() {
        if (this._signalStrength === undefined)
            this._signalStrength = -1;

        return this._signalStrength;
    }

    get network_type() {
        if (this._networkType === undefined)
            this._networkType = '';

        return this._networkType;
    }

    get signal_strength_icon_name() {
        if (this.signal_strength === 0)
            return 'network-cellular-signal-none-symbolic'; // SIGNAL_STRENGTH_NONE_OR_UNKNOWN
        else if (this.signal_strength === 1)
            return 'network-cellular-signal-weak-symbolic'; // SIGNAL_STRENGTH_POOR
        else if (this.signal_strength === 2)
            return 'network-cellular-signal-ok-symbolic'; // SIGNAL_STRENGTH_MODERATE
        else if (this.signal_strength === 3)
            return 'network-cellular-signal-good-symbolic'; // SIGNAL_STRENGTH_GOOD
        else if (this.signal_strength >= 4)
            return 'network-cellular-signal-excellent-symbolic'; // SIGNAL_STRENGTH_GREAT

        return 'network-cellular-offline-symbolic'; // OFF (signal_strength == -1)
    }

    get network_type_icon_name() {
        if (this.network_type === 'GSM' || this.network_type === 'CDMA' || this.network_type === 'iDEN')
            return 'network-cellular-2g-symbolic';
        else if (this.network_type === 'UMTS' || this.network_type === 'CDMA2000')
            return 'network-cellular-3g-symbolic';
        else if (this.network_type === 'LTE')
            return 'network-cellular-4g-symbolic';
        else if (this.network_type === 'EDGE')
            return 'network-cellular-edge-symbolic';
        else if (this.network_type === 'GPRS')
            return 'network-cellular-gprs-symbolic';
        else if (this.network_type === 'HSPA')
            return 'network-cellular-hspa-symbolic';
        // FIXME: No icon for this!
        // https://gitlab.gnome.org/GNOME/adwaita-icon-theme/-/issues/114
        else if (this.network_type === '5G')
            return 'network-cellular-symbolic';

        return 'network-cellular-symbolic';
    }

    get state() {
        return new GLib.Variant(
            '(ssis)',
            [
                this.network_type,
                this.network_type_icon_name,
                this.signal_strength,
                this.signal_strength_icon_name,
            ]
        );
    }

    connected() {
        super.connected();

        this._requestState();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.connectivity_report':
                this._receiveState(packet);
                break;
        }
    }

    /**
     * Handle a remote state update.
     *
     * @param {Core.Packet} packet - A kdeconnect.connectivity_report packet
     */
    _receiveState(packet) {
        if (packet.body.signalStrengths) {
            // TODO: Only first SIM (subscriptionID) is supported at the moment
            const subs = Object.keys(packet.body.signalStrengths);
            const firstSub = Math.min.apply(null, subs);
            const data = packet.body.signalStrengths[firstSub];

            this._networkType = data.networkType;
            this._signalStrength = data.signalStrength;
        }

        // Update DBus state
        this.__state.state = this.state;
    }

    /**
     * Request the remote device's connectivity state
     */
    _requestState() {
        this.device.sendPacket({
            type: 'kdeconnect.connectivity_report.request',
            body: {},
        });
    }

    destroy() {
        this.device.remove_action('connectivity_report');

        super.destroy();
    }
});
