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
            // Connect to the mixer
            this._pulseaudio = this.service.components.get('pulseaudio');

            this._streamChangedId = this._pulseaudio.connect(
                'stream-changed',
                this._sendSink.bind(this)
            );

            this._outputAddedId = this._pulseaudio.connect(
                'output-added',
                this._sendSinkList.bind(this)
            );

            this._outputRemovedId = this._pulseaudio.connect(
                'output-removed',
                this._sendSinkList.bind(this)
            );

            // Cache stream properties
            this._cache = new WeakMap();
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

        for (let sink of this._pulseaudio.get_sinks()) {
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
     * @return {object} - The updated cache object
     */
    _updateCache(stream) {
        let state = {
            name: stream.name,
            description: stream.display_name,
            muted: stream.is_muted,
            volume: stream.volume,
            maxVolume: this._pulseaudio.get_vol_max_norm()
        };

        this._cache.set(stream, state);

        return state;
    }

    /**
     * Send the state of a local sink
     *
     * @param {Gvc.MixerControl} mixer - The mixer that owns the stream
     * @param {Number} id - The Id of the stream that changed
     */
    _sendSink(mixer, id) {
        // Avoid starving the packet channel when fading
        if (this._pulseaudio.fading) {
            return;
        }

        // Check the cache
        let stream = this._pulseaudio.lookup_stream_id(id);
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
                body: state
            });
        }
    }

    /**
     * Send a list of local sinks
     */
    _sendSinkList() {
        let sinkList = this._pulseaudio.get_sinks().map(sink => {
            return this._updateCache(sink);
        });

        // Send the sinkList
        this.device.sendPacket({
            type: 'kdeconnect.systemvolume',
            body: {
                sinkList: sinkList
            }
        });
    }

    destroy() {
        try {
            this._pulseaudio.disconnect(this._streamChangedId);
            this._pulseaudio.disconnect(this._outputAddedId);
            this._pulseaudio.disconnect(this._outputRemovedId);
        } catch (e) {
            debug(e, this.device.name);
        }

        super.destroy();
    }
});

