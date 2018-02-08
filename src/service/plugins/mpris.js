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
            this.mpris = MPRIS.get_default();
            this.mpris.connect("notify::players", () => this._sendPlayerList());
            this._sendPlayerList();
            this.mpris.connect("player-changed", (mpris, player, names) => {
                this._handleCommand({
                    body: {
                        player: player.Identity,
                        requestNowPlaying: true,
                        requestVolume: true
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
            if (packet.body.requestPlayerList) {
                this._sendPlayerList();
            } else if (packet.body.hasOwnProperty("player")) {
                // If we have this player
                if (this.mpris.players[packet.body.player]) {
                    resolve(this._handleCommand(packet));
                // If we don't, send an updated list to the device
                } else {
                    resolve(this._sendPlayerList());
                }
            }
        });
    },

    /**
     * Local
     */
    _handleCommand: function (packet) {
        // FIXME FIXME FIXME
        debug(packet);

        return new Promise((resolve, reject) => {
            if (!(this.allow & 4)) {
                debug("Not allowed");
                reject(new Error("Operation not permitted: " + packet.type));
            }

            let player = this.mpris.players[packet.body.player].Player;

            // Player Actions
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

            // Player Properties
            if (packet.body.hasOwnProperty("setVolume")) {
                player.Volume = packet.body.setVolume / 100;
            }

            if (packet.body.hasOwnProperty("Seek")) {
                player.Seek(packet.body.Seek);
            }

            if (packet.body.hasOwnProperty("SetPosition")) {
                player.Seek((packet.body.SetPosition * 1000) - player.Position);
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
                    pos: Math.round(player.Position / 1000), /* TODO: really? */
                    isPlaying: (player.PlaybackStatus === "Playing"),
                    canPause: player.CanPause,
                    canPlay: player.CanPlay,
                    canGoNext: player.CanGoNext,
                    canGoPrevious: player.CanGoPrevious,
                    canSeek: player.CanSeek
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

            resolve(hasResponse ? response : "No response");
        });
    },

    _sendPlayerList: function () {
        debug("MPRIS: _sendPlayerList()");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.mpris",
            body: { playerList: this.mpris.identities }
        });

        this.send(packet);
    }
});

