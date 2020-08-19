'use strict';

const GObject = imports.gi.GObject;

const Components = imports.service.components;
const Config = imports.config;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('System Volume'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SystemVolume',
    incomingCapabilities: ['kdeconnect.systemvolume.request'],
    outgoingCapabilities: ['kdeconnect.systemvolume'],
    actions: {},
};


/**
 * SystemVolume Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/systemvolume
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SystemvolumePlugin/
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSystemVolumePlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'systemvolume');

        // Cache stream properties
        this._cache = new WeakMap();

        // Connect to the mixer
        try {
            this._mixer = Components.acquire('pulseaudio');

            this._streamChangedId = this._mixer.connect(
                'stream-changed',
                this._sendSink.bind(this)
            );

            this._outputAddedId = this._mixer.connect(
                'output-added',
                this._sendSinkList.bind(this)
            );

            this._outputRemovedId = this._mixer.connect(
                'output-removed',
                this._sendSinkList.bind(this)
            );

        // Modify the error to redirect to the wiki
        } catch (e) {
            e.name = _('PulseAudio not found');
            e.url = `${Config.PACKAGE_URL}/wiki/Error#pulseaudio-not-found`;
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
     *
     * @param {Core.Packet} packet - a `kdeconnect.systemvolume.request`
     */
    _changeSink(packet) {
        let stream;

        for (let sink of this._mixer.get_sinks()) {
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
        let cache = this._cache.get(stream) || {};

        if (packet.body.hasOwnProperty('muted')) {
            cache.muted = packet.body.muted;
            this._cache.set(stream, cache);
            stream.change_is_muted(packet.body.muted);
        }

        if (packet.body.hasOwnProperty('volume')) {
            cache.volume = packet.body.volume;
            this._cache.set(stream, cache);
            stream.volume = packet.body.volume;
            stream.push_volume();
        }
    }

    /**
     * Update the cache for @stream
     *
     * @param {Gvc.MixerStream} stream - The stream to cache
     * @return {Object} The updated cache object
     */
    _updateCache(stream) {
        let state = {
            name: stream.name,
            description: stream.display_name,
            muted: stream.is_muted,
            volume: stream.volume,
            maxVolume: this._mixer.get_vol_max_norm(),
        };

        this._cache.set(stream, state);

        return state;
    }

    /**
     * Send the state of a local sink
     *
     * @param {Gvc.MixerControl} mixer - The mixer that owns the stream
     * @param {number} id - The Id of the stream that changed
     */
    _sendSink(mixer, id) {
        // Avoid starving the packet channel when fading
        if (this._mixer.fading)
            return;

        // Check the cache
        let stream = this._mixer.lookup_stream_id(id);
        let cache = this._cache.get(stream) || {};

        // If the port has changed we have to send the whole list to update the
        // display name
        if (!cache.display_name || cache.display_name !== stream.display_name) {
            this._sendSinkList();
            return;
        }

        // If only volume and/or mute are set, send a single update
        if (cache.volume !== stream.volume || cache.muted !== stream.is_muted) {
            // Update the cache
            let state = this._updateCache(stream);

            // Send the stream update
            this.device.sendPacket({
                type: 'kdeconnect.systemvolume',
                body: state,
            });
        }
    }

    /**
     * Send a list of local sinks
     */
    _sendSinkList() {
        let sinkList = this._mixer.get_sinks().map(sink => {
            return this._updateCache(sink);
        });

        // Send the sinkList
        this.device.sendPacket({
            type: 'kdeconnect.systemvolume',
            body: {
                sinkList: sinkList,
            },
        });
    }

    destroy() {
        if (this._mixer !== undefined) {
            this._mixer.disconnect(this._streamChangedId);
            this._mixer.disconnect(this._outputAddedId);
            this._mixer.disconnect(this._outputRemovedId);
            this._mixer = Components.release('pulseaudio');
        }

        super.destroy();
    }
});

