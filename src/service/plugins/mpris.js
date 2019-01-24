'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('MPRIS'),
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
 *       https://github.com/KDE/kdeconnect-kde/commit/9e0d4874c072646f1018ad413d59d1f43e590777
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'mpris');

        try {
            this._notifyPlayersId = this.service.mpris.connect(
                'notify::players',
                this._sendPlayerList.bind(this)
            );

            this._playerChangedId = this.service.mpris.connect(
                'player-changed',
                this._onPlayerChanged.bind(this)
            );

            this._playerSeekedId = this.service.mpris.connect(
                'player-seeked',
                this._onPlayerSeeked.bind(this)
            );
        } catch (e) {
            this.destroy();
            throw new Error('mpris-error');
        }
    }

    handlePacket(packet) {
        // A request for the list of players
        if (packet.body.requestPlayerList) {
            this._sendPlayerList();

        // A request for an unknown player; send the list of players
        } else if (!this.service.mpris.players.has(packet.body.player)) {
            this._sendPlayerList();

        // An album art request
        } else if (packet.body.hasOwnProperty('albumArtUrl')) {
            this._sendAlbumArt(packet);

        // A player command
        } else {
            this._handleCommand(packet);
        }
    }

    connected() {
        super.connected();

        this._sendPlayerList();
    }

    /**
     * Handle an incoming player command or information request
     *
     * @param {kdeconnect.mpris.request} - A command for a specific player
     */
    async _handleCommand(packet) {
        if (this._updating || !this.settings.get_boolean('share-players')) {
            return;
        }

        try {
            this._updating = true;

            let player = this.service.mpris.players.get(packet.body.player);

            // Player Actions
            if (packet.body.hasOwnProperty('action')) {
                switch (packet.body.action) {
                    case 'PlayPause':
                    case 'Play':
                    case 'Pause':
                    case 'Next':
                    case 'Previous':
                    case 'Stop':
                        player[packet.body.action]();
                        break;

                    default:
                        logError(new Error(`unknown action: ${packet.body.action}`));
                }
            }

            // Player Properties
            if (packet.body.hasOwnProperty('setVolume')) {
                player.Volume = packet.body.setVolume / 100;
            }

            if (packet.body.hasOwnProperty('Seek')) {
                await player.Seek(packet.body.Seek);
            }

            if (packet.body.hasOwnProperty('SetPosition')) {
                let offset = (packet.body.SetPosition * 1000) - player.Position;
                await player.Seek(offset);
            }

            // Information Request
            let hasResponse = false;

            let response = {
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
        } catch (e) {
            logError(e);
        } finally {
            this._updating = false;
        }
    }

    /**
     * Get the track metadata for a player
     *
     * @param {Gio.DBusProxy} player - The player to get track info for
     * @return {Object} - An object of track data in MPRIS packet body format
     */
    _getPlayerMetadata(player) {
        let metadata = {};

        try {
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
        } catch (e) {
            logError(e);
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

    _onPlayerSeeked(mpris, player) {
        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                player: player.Identity,
                pos: Math.floor(player.Position / 1000)
            }
        });
    }

    async _sendAlbumArt(packet) {
        try {
            // Reject concurrent requests for album art
            if (this._transferring) {
                return;
            }

            let player = this.service.mpris.players.get(packet.body.player);

            if (player.Metadata === null) {
                return;
            }

            // Ensure the requested albumArtUrl matches the current mpris:artUrl
            if (packet.body.albumArtUrl !== player.Metadata['mpris:artUrl']) {
                return;
            }

            // Start the transfer process
            this._transferring = true;

            let file = Gio.File.new_for_uri(packet.body.albumArtUrl);

            let transfer = this.device.createTransfer({
                input_stream: file.read(null),
                size: file.query_info('standard::size', 0, null).get_size()
            });

            await transfer.upload({
                id: 0,
                type: 'kdeconnect.mpris',
                body: {
                    transferringAlbumArt: true,
                    player: packet.body.player,
                    albumArtUrl: packet.body.albumArtUrl
                }
            });
        } catch (e) {
            warning(e, `${this.device.name}: transferring album art`);
        } finally {
            this._transferring = false;
        }
    }

    /**
     * Send the list of player identities and indicate whether we support
     * transferring album art
     */
    _sendPlayerList() {
        let playerList = [];

        if (this.settings.get_boolean('share-players')) {
            playerList = this.service.mpris.identities;
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.mpris',
            body: {
                playerList: playerList,
                supportAlbumArtPayload: (this.device.connection_type === 'tcp')
            }
        });
    }

    destroy() {
        try {
            this.service.mpris.disconnect(this._notifyPlayersId);
            this.service.mpris.disconnect(this._playerChangedId);
            this.service.mpris.disconnect(this._playerSeekedId);
        } catch (e) {
            // Silence errors
        }

        super.destroy();
    }
});

