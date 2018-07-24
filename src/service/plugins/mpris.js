'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

const Lan = imports.service.lan;
const MPRIS = imports.modules.mpris;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.MPRIS',
    incomingCapabilities: ['kdeconnect.mpris.request'],
    outgoingCapabilities: ['kdeconnect.mpris'],
    actions: {}
};


/**
 * MPRIS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mpriscontrol
 *
 * See also:
 *     https://specifications.freedesktop.org/mpris-spec/latest/
 *     https://github.com/GNOME/gnome-shell/blob/master/js/ui/mpris.js
 *     https://github.com/JasonLG1979/gnome-shell-extensions-mediaplayer/wiki/Known-Player-Bugs
 *
 * TODO: It's probably possible to mirror a remote MPRIS2 player on local DBus
 *       See #39 https://github.com/andyholmes/gnome-shell-extension-gsconnect/pull/39
 *       https://github.com/KDE/kdeconnect-kde/commit/9e0d4874c072646f1018ad413d59d1f43e590777
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'mpris');

        try {
            this.mpris = MPRIS.get_default();

            this._playersChangedId = this.mpris.connect(
                'notify::players',
                this._sendPlayerList.bind(this)
            );

            this._playerChangedId = this.mpris.connect(
                'player-changed',
                this._onPlayerChanged.bind(this)
            );

            this._sendPlayerList();
        } catch (e) {
            this.destroy();
            throw Error('MPRIS: ' + e.message);
        }
    }

    handlePacket(packet) {
        if (packet.body.requestPlayerList) {
            this._sendPlayerList();
        } else if (packet.body.hasOwnProperty('player')) {
            // If we have this player
            if (this.mpris.players.has(packet.body.player)) {
                this._handleCommand(packet);
            // If we don't, send an updated list to the device instead
            } else {
                this._sendPlayerList();
            }
        }
    }

    /**
     * Local
     */
    /**
     * Handle an incoming player command or information request
     * @param {Core.Packet} -
     */
    _handleCommand(packet) {
        let player = this.mpris.players.get(packet.body.player);

        // Send Album Art
        if (packet.body.hasOwnProperty('albumArtUrl')) {
            this._sendAlbumArt(packet);
        }

        // Player Actions
        if (packet.body.hasOwnProperty('action')) {
            switch (packet.body.action) {
                case 'PlayPause':
                    player.PlayPause();
                    break;
                case 'Play':
                    player.Play();
                    break;
                case 'Pause':
                    player.Pause();
                    break;
                case 'Next':
                    player.Next();
                    break;
                case 'Previous':
                    player.Previous();
                    break;
                case 'Stop':
                    player.Stop();
                    break;
                default:
                    debug('unknown action: ' + packet.body.action);
            }
        }

        // Player Properties
        if (packet.body.hasOwnProperty('setVolume')) {
            player.Volume = packet.body.setVolume / 100;
        }

        if (packet.body.hasOwnProperty('Seek')) {
            player.Seek(packet.body.Seek);
        }

        if (packet.body.hasOwnProperty('SetPosition')) {
            player.Seek((packet.body.SetPosition * 1000) - player.Position);
        }

        // Information Request
        let hasResponse = false;

        let response = {
            id: 0,
            type: 'kdeconnect.mpris',
            body: {}
        };

        if (packet.body.hasOwnProperty('requestNowPlaying')) {
            hasResponse = true;

            response.body = {
                pos: Math.floor(player.Position / 1000),
                isPlaying: (player.PlaybackStatus === 'Playing'),
                canPause: player.CanPause,
                canPlay: player.CanPlay,
                canGoNext: player.CanGoNext,
                canGoPrevious: player.CanGoPrevious,
                canSeek: player.CanSeek
            };

            Object.assign(response.body, this._getPlayerMetadata(player));
        }

        if (packet.body.hasOwnProperty('requestVolume')) {
            hasResponse = true;
            response.body.volume = player.Volume * 100;
        }

        if (hasResponse) {
            response.body.player = packet.body.player;
            this.device.sendPacket(response);
        }
    }

    /**
     * Get the track metadata for a player
     * @param {Gio.DBusProxy} player - The player to get track info for
     * @return {Object} - An object of track data in MPRIS packet body format
     */
    _getPlayerMetadata(player) {
        let metadata = {};

        if (player.Metadata !== null) {
            let nowPlaying = player.Metadata['xesam:title'];

            if (player.Metadata.hasOwnProperty('xesam:artist')) {
                nowPlaying = `${player.Metadata['xesam:artist']} - ${nowPlaying}`;
            }

            metadata.nowPlaying = nowPlaying;

            if (player.Metadata.hasOwnProperty('mpris:artUrl')) {
                metadata.albumArtUrl = player.Metadata['mpris:artUrl'];
            }

            if (player.Metadata.hasOwnProperty('mpris:length')) {
                metadata.length = Math.floor(player.Metadata['mpris:length'] / 1000);
            }
        }

        return metadata;
    }

    _onPlayerChanged(mpris, player) {
        if (!this.settings.get_boolean('share-players')) {
            return;
        }

        this._handleCommand({
            body: {
                player: player.Identity,
                requestNowPlaying: true,
                requestVolume: true
            }
        });
    }

    _sendAlbumArt(packet) {
        // Reject concurrent requests for album art
        if (this._transferring) {
            logWarning('Rejecting concurrent album art request', this.device.name);
            return;
        }

        let player = this.mpris.players.get(packet.body.player);

        if (player.Metadata === null) {
            return;
        }

        // Ensure the requested albumArtUrl matches the current mpris:artUrl
        if (packet.body.albumArtUrl !== player.Metadata['mpris:artUrl']) {
            return;
        }

        if (this.device.connection_type === 'tcp') {
            this._transferring = true;

            let file = Gio.File.new_for_uri(packet.body.albumArtUrl);

            let transfer = new Lan.Transfer({
                device: this.device,
                size: file.query_info('standard::size', 0, null).get_size(),
                input_stream: file.read(null)
            });

            transfer.connect('connected', () => transfer.start());
            transfer.connect('disconnected', () => { delete this._transferring });

            transfer.upload().then(port => {
                this.device.sendPacket({
                    id: 0,
                    type: 'kdeconnect.mpris',
                    body: {
                        transferringAlbumArt: true,
                        player: packet.body.player,
                        albumArtUrl: packet.body.albumArtUrl
                    },
                    payloadSize: transfer.size,
                    payloadTransferInfo: { port: port }
                });
            });
        }
    }

    _sendPlayerList() {
        let playerList = [];
        let supportAlbumArtPayload = false;

        if (this.settings.get_boolean('share-players')) {
            playerList = this.mpris.identities;
            // TODO: bluetooth
            supportAlbumArtPayload = (this.device.connection_type === 'tcp');
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.mpris',
            body: {
                playerList: playerList,
                supportAlbumArtPayload: supportAlbumArtPayload
            }
        });
    }

    destroy() {
        this.mpris.disconnect(this._playersChangedId);
        this.mpris.disconnect(this._playerChangedId);

        super.destroy();
    }
});

