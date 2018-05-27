'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

const Core = imports.service.core;
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
        debug(packet);

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
    _handleCommand(packet) {
        debug(packet);

        let player = this.mpris.players.get(packet.body.player).Player;

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

        let response = new Core.Packet({
            id: 0,
            type: 'kdeconnect.mpris',
            body: {}
        });

        if (packet.body.hasOwnProperty('requestNowPlaying')) {
            hasResponse = true;

            // Unpack variants
            let Metadata = {};
            for (let entry in player.Metadata) {
                Metadata[entry] = player.Metadata[entry].deep_unpack();
            }

            let nowPlaying = Metadata['xesam:title'];
            if (Metadata.hasOwnProperty('xesam:artist')) {
                nowPlaying = Metadata['xesam:artist'] + ' - ' + nowPlaying;
            }

            response.body = {
                nowPlaying: nowPlaying,
                pos: Math.round(player.Position / 1000), /* TODO: really? */
                isPlaying: (player.PlaybackStatus === 'Playing'),
                canPause: player.CanPause,
                canPlay: player.CanPlay,
                canGoNext: player.CanGoNext,
                canGoPrevious: player.CanGoPrevious,
                canSeek: player.CanSeek
            };
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

    _onPlayerChanged(mpris, player, names) {
        this._handleCommand({
            body: {
                player: player.Identity,
                requestNowPlaying: true,
                requestVolume: true
            }
        });
    }

    _sendPlayerList() {
        debug('MPRIS: _sendPlayerList()');

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.mpris',
            body: { playerList: this.mpris.identities }
        });
    }

    destroy() {
        this.mpris.disconnect(this._playersChangedId);
        this.mpris.disconnect(this._playerChangedId);

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

