'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('System Volume'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SystemVolume',
    incomingCapabilities: ['kdeconnect.systemvolume.request'],
    outgoingCapabilities: ['kdeconnect.systemvolume'],
    actions: {}
};


/**
 * SystemVolume Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/systemvolume
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SystemvolumePlugin/
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSystemVolumePlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'systemvolume');

        try {
            // Cache stream properties
            this._cache = new WeakMap();

            // Connect to the mixer
            this._streamChangedId = this.service.pulseaudio.connect(
                'stream-changed',
                this._sendSink.bind(this)
            );

            this._outputAddedId = this.service.pulseaudio.connect(
                'output-added',
                this._sendSinkList.bind(this)
            );

            this._outputRemovedId = this.service.pulseaudio.connect(
                'output-removed',
                this._sendSinkList.bind(this)
            );
        } catch (e) {
            this.destroy();
            e.name = 'GvcError';
            throw e;
        }
    }

    handlePacket(packet) {
        switch (true) {
            case packet.body.hasOwnProperty('requestSinks'):
                this._sendSinkList();
                break;

            case packet.body.hasOwnProperty('name'):
                this._changeSink(packet);
                break;
        }
    }

    connected() {
        super.connected();

        this._sendSinkList();
    }

    /**
     * Handle a request to change an output
     */
    _changeSink(packet) {
        let stream;

        for (let sink of this.service.pulseaudio.get_sinks()) {
            if (sink.name === packet.body.name) {
                stream = sink;
                break;
            }
        }

        // No sink with the given name
        if (stream === undefined) {
            this._sendSinkList();
            return;
        }

        // Get a cache and store volume and mute states if changed
        let cache = this._cache.get(stream) || [null, null, null];

        if (packet.body.hasOwnProperty('muted')) {
            cache[1] = packet.body.muted;
            this._cache.set(stream, cache);
            stream.change_is_muted(packet.body.muted);
        }

        if (packet.body.hasOwnProperty('volume')) {
            cache[0] = packet.body.volume;
            this._cache.set(stream, cache);
            stream.volume = packet.body.volume;
            stream.push_volume();
        }
    }

    /**
     * Send the state of a local sink
     *
     * @param {Gvc.MixerControl} mixer - The mixer that owns the stream
     * @param {Number} id - The Id of the stream that changed
     */
    _sendSink(mixer, id) {
        let stream = this.service.pulseaudio.lookup_stream_id(id);

        // Get a cache to check for changes
        let cache = this._cache.get(stream) || [null, null, null];

        switch (true) {
            // If the port (we show in the description) has changed we have to
            // send the whole list to show the change
            case (cache[2] !== stream.display_name):
                this._sendSinkList();
                return;

            // If only volume and/or mute are set, send a single update
            case (cache[0] !== stream.volume):
            case (cache[1] !== stream.is_muted):
                this._cache.set(stream, [
                    stream.volume,
                    stream.is_muted,
                    stream.display_name
                ]);
                break;

            // Bail if nothing relevant has changed
            default:
                return;
        }

        // Send the stream update
        this.device.sendPacket({
            type: 'kdeconnect.systemvolume',
            body: {
                name: stream.name,
                volume: stream.volume,
                muted: stream.is_muted
            }
        });
    }

    /**
     * Send a list of local sinks
     */
    _sendSinkList() {
        let sinkList = this.service.pulseaudio.get_sinks().map(sink => {
            // Cache the sink state
            this._cache.set(sink, [
                sink.volume,
                sink.is_muted,
                sink.display_name
            ]);

            // return a sinkList entry
            return {
                name: sink.name,
                description: sink.display_name,
                muted: sink.is_muted,
                volume: sink.volume,
                maxVolume: this.service.pulseaudio.get_vol_max_norm()
            };
        });

        // Send the sinkList
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.systemvolume',
            body: {
                sinkList: sinkList
            }
        });
    }

    destroy() {
        try {
            this.service.pulseaudio.disconnect(this._streamChangedId);
            this.service.pulseaudio.disconnect(this._outputAddedId);
            this.service.pulseaudio.disconnect(this._outputRemovedId);
        } catch (e) {
        }

        super.destroy();
    }
});

