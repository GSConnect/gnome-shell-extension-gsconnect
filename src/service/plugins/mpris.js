"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const MPRIS = imports.modules.mpris;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.MPRIS",
    incomingPackets: ["kdeconnect.mpris.request"],
    outgoingPackets: ["kdeconnect.mpris"]
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
var Plugin = new Lang.Class({
    Name: "GSConnectMPRISPlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "mpris");

        try {
            this.mpris = new MPRIS.Manager();
            this.mpris.connect("notify::players", (mpris) => {
                log("MPRIS names: " + this.mpris.names);
                log("MPRIS players: " + this.mpris.players);
                this._sendPlayerList();
            });
            this.mpris.connect("player-changed", (mpris, player, names) => {
                this._handleCommand({
                    body: {
                        player: player.identity,
                        requestNowPlaying: true
                    }
                });
            });
        } catch (e) {
            this.destroy();
            throw Error("MPRIS: " + e.message);
        }
    },

    handlePacket: function (packet) {
        debug(packet);

        return new Promise((resolve, reject) => {
            if (packet.body.hasOwnProperty("requestPlayerList")) {
                this._sendPlayerList();
            } else if (packet.body.hasOwnProperty("player")) {
                if (this.mpris._players.has(packet.body.player)) {
                    resolve(this._handleCommand(packet));
                } else {
                    this._updatePlayers();
                    resolve(true);
                }
            }
        });
    },

    /**
     * Local
     */
    _handleCommand: function (packet) {
        debug("MPRIS: handleCommand()");

        // FIXME FIXME FIXME
        if (!this.settings.get_boolean("mpris-view")) {
            return;
        } else if (!this.settings.get_boolean("mpris-control")) {
            let control = false;
        }

        return new Promise((resolve, reject) => {
            let player = this.mpris._players.get(packet.body.player);

            // Player Commands
            if (packet.body.hasOwnProperty("action")) {
                switch (packet.body.action) {
                    case "PlayPause":
                        resolve(player.PlayPause());
                        break;
                    case "Play":
                        resolve(player.Play());
                        break;
                    case "Pause":
                        resolve(player.Pause());
                        break;
                    case "Next":
                        resolve(player.Next());
                        break;
                    case "Previous":
                        resolve(player.Previous());
                        break;
                    case "Stop":
                        resolve(player.Stop());
                        break;
                    default:
                        reject(new Error("unknown action: " + packet.body.action));
                }
            }

            if (packet.body.hasOwnProperty("setVolume")) {
                player.Volume = packet.body.setVolume / 100;
            }

            if (packet.body.hasOwnProperty("Seek")) {
                player.Seek(packet.body.Seek);
            }

            if (packet.body.hasOwnProperty("SetPosition")) {
                let position = (packet.body.SetPosition * 1000) - player.Position;
                player.Seek(position);
            }

            let response = new Protocol.Packet({
                id: 0,
                type: "kdeconnect.mpris",
                body: {}
            });

            // Information Request
            let hasResponse = false;

            if (packet.body.hasOwnProperty("requestNowPlaying")) {
                hasResponse = true;

                // Unpack variants
                let Metadata = {};
                for (let entry in player.Metadata) {
                    Metadata[entry] = player.Metadata[entry].deep_unpack();
                }

                let nowPlaying = Metadata["xesam:title"];
                if (Metadata.hasOwnProperty("xesam:artist")) {
                    nowPlaying = Metadata["xesam:artist"] + " - " + nowPlaying;
                }

                response.body = {
                    nowPlaying: nowPlaying,
                    pos: Math.round(player.Position / 1000),
                    isPlaying: (player.PlaybackStatus === "Playing"),
                    canPause: (player.CanPause === true),
                    canPlay: (player.CanPlay === true),
                    canGoNext: (player.CanGoNext === true),
                    canGoPrevious: (player.CanGoPrevious === true),
                    canSeek: (player.CanSeek === true)
                };

            }

            if (packet.body.hasOwnProperty("requestVolume")) {
                hasResponse = true;
                response.body.volume = player.Volume * 100;
            }

            if (hasResponse) {
                response.body.player = packet.body.player;
                this.device._channel.send(response);
            }

            resolve(true);
        });
    },

    _sendPlayerList: function () {
        debug("MPRIS: _sendPlayerList()");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.mpris",
            body: { playerList: this.mpris.names }
        });

        this.send(packet);
    },

    destroy: function () {
        try {
            this.mpris.destroy();
        } catch (e) {
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

