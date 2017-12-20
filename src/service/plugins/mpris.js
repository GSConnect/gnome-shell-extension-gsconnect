"use strict";

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Lang = imports.lang;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    summary: _("Media Player Control"),
    description: _("Control MPRIS2 enabled media players"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.MPRIS",
    incomingPackets: ["kdeconnect.mpris.request"],
    outgoingPackets: ["kdeconnect.mpris"]
};


const DBusProxy = new Gio.DBusProxy.makeProxyWrapper(
'<node> \
<interface name="org.freedesktop.DBus"> \
  <method name="ListNames"> \
    <arg type="as" direction="out" name="names" /> \
  </method> \
  <signal name="NameOwnerChanged"> \
    <arg type="s" direction="out" name="name" /> \
    <arg type="s" direction="out" name="oldOwner" /> \
    <arg type="s" direction="out" name="newOwner" /> \
  </signal> \
</interface> \
</node>');


const MPRISProxy = new Gio.DBusProxy.makeProxyWrapper(
'<node> \
  <interface name="org.mpris.MediaPlayer2"> \
      <method name="Raise" /> \
      <method name="Quit" /> \
      <property name="CanQuit" type="b" access="read" /> \
      <property name="Fullscreen" type="b" access="readwrite" /> \
      <property name="CanRaise" type="b" access="read" /> \
      <property name="HasTrackList" type="b" access="read"/> \
      <property name="Identity" type="s" access="read"/> \
      <property name="DesktopEntry" type="s" access="read"/> \
      <property name="SupportedUriSchemes" type="as" access="read"/> \
      <property name="SupportedMimeTypes" type="as" access="read"/> \
  </interface> \
</node>');


const MPRISPlayerProxy = new Gio.DBusProxy.makeProxyWrapper(
'<node> \
  <interface name="org.mpris.MediaPlayer2.Player"> \
    <method name="Next"/> \
    <method name="Previous"/> \
    <method name="Pause"/> \
    <method name="PlayPause"/> \
    <method name="Stop"/> \
    <method name="Play"/> \
    <method name="Seek"> \
      <arg direction="in" type="x" name="Offset"/> \
    </method> \
    <method name="SetPosition"> \
      <arg direction="in" type="o" name="TrackId"/> \
      <arg direction="in" type="x" name="Position"/> \
    </method> \
    <method name="OpenUri"> \
      <arg direction="in" type="s"/> \
    </method> \
    <!-- Signals --> \
    <signal name="Seeked"> \
      <arg type="x" name="Position"/> \
    </signal> \
    <!-- Properties --> \
    <property access="read" type="s" name="PlaybackStatus"/> \
    <property access="readwrite" type="s" name="LoopStatus"/> \
    <property access="readwrite" type="d" name="Rate"/> \
    <property access="readwrite" type="b" name="Shuffle"/> \
    <property access="read" type="a{sv}" name="Metadata"/> \
    <property access="readwrite" type="d" name="Volume"/> \
    <property access="read" type="x" name="Position"/> \
    <property access="read" type="d" name="MinimumRate"/> \
    <property access="read" type="d" name="MaximumRate"/> \
    <property access="read" type="b" name="CanGoNext"/> \
    <property access="read" type="b" name="CanGoPrevious"/> \
    <property access="read" type="b" name="CanPlay"/> \
    <property access="read" type="b" name="CanPause"/> \
    <property access="read" type="b" name="CanSeek"/> \
    <property access="read" type="b" name="CanControl"/> \
  </interface> \
</node>');


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
var Plugin = new Lang.Class({
    Name: "GSConnectMPRISPlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "mpris");

        try {
            this._listener = new DBusProxy(
                Gio.DBus.session,
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                (proxy, error) => {
                    if (error === null) {
                        this._updatePlayers();

                        this._nameOwnerChanged = proxy.connectSignal(
                            'NameOwnerChanged',
                            Lang.bind(this, this._onNameOwnerChanged)
                        );
                    }
                }
            );

            this._players = new Map();
        } catch (e) {
            this.destroy();
            throw Error("MPRIS: " + e.message);
        }
    },

    _onNameOwnerChanged: function(proxy, sender, [name, oldOwner, newOwner]) {
        if (name.startsWith("org.mpris.MediaPlayer2")) {
            this._updatePlayers();
        }
    },

    _listPlayers: function () {
        Common.debug("MPRIS: _listPlayers()");

        let players = [];

        for (let name of this._listener.ListNamesSync()[0]) {

            if (name.indexOf("org.mpris.MediaPlayer2") > -1) {
                players.push(name);
            }
        }

        return players;
    },

    _updatePlayers: function () {
        Common.debug("MPRIS: _updatePlayers()");

        let players = this._listPlayers();

        // Add new players
        for (let name of players) {
            let mpris = MPRISProxy(
                Gio.DBus.session,
                name,
                "/org/mpris/MediaPlayer2"
            );

            if (!this._players.has(mpris.Identity)) {
                let player = new MPRISPlayerProxy(
                    Gio.DBus.session,
                    name,
                    "/org/mpris/MediaPlayer2"
                );

                // TODO: resending everything if anything changes
                player.connect("g-properties-changed", () => {
                    let packet = new Protocol.Packet({
                        id: 0,
                        type: "kdeconnect.mpris.request",
                        body: {
                            player: mpris.Identity,
                            requestNowPlaying: true,
                            requestVolume: true
                        }
                    });

                    this.handleCommand(packet);
                });

                this._players.set(mpris.Identity, player);
            }
        }

        // Remove old players
        for (let [name, proxy] of this._players.entries()) {
            if (players.indexOf(proxy.gName) < 0) {
                GObject.signal_handlers_destroy(proxy);
                this._players.delete(name);
            }
        }

        this.sendPlayerList();
    },

    handlePacket: function (packet) {
        Common.debug("MPRIS: handlePacket()");

        if (packet.body.hasOwnProperty("requestPlayerList")) {
            this.sendPlayerList();
        } else if (packet.body.hasOwnProperty("player")) {
            if (this._players.has(packet.body.player)) {
                this.handleCommand(packet);
            } else {
                this._updatePlayers();
            }
        }
    },

    sendPlayerList: function () {
        Common.debug("MPRIS: sendPlayerList()");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.mpris",
            body: { playerList: Array.from(this._players.keys()) }
        });

        this.device._channel.send(packet);
    },

    handleCommand: function (packet) {
        Common.debug("MPRIS: handleCommand()");

        let player = this._players.get(packet.body.player);

        // Player Commands
        if (packet.body.hasOwnProperty("action")) {
            if (packet.body.action === "PlayPause") { player.PlayPauseSync(); }
            if (packet.body.action === "Play") { player.PlaySync(); }
            if (packet.body.action === "Pause") { player.PauseSync(); }
            if (packet.body.action === "Next") { player.NextSync(); }
            if (packet.body.action === "Previous") { player.PreviousSync(); }
            if (packet.body.action === "Stop") { player.StopSync(); }
        }

        if (packet.body.hasOwnProperty("setVolume")) {
            player.Volume = packet.body.setVolume / 100;
        }

        if (packet.body.hasOwnProperty("Seek")) {
            player.SeekSync(packet.body.Seek);
        }

        if (packet.body.hasOwnProperty("SetPosition")) {
            let position = (packet.body.SetPosition * 1000) - player.Position;
            player.SeekSync(position);
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
    },

    destroy: function () {
        try {
            this._listener.disconnectSignal(this._nameOwnerChanged);
        } catch (e) {
        }

        for (let proxy of this._players.values()) {
            try {
                GObject.signal_handlers_destroy(proxy);
            } catch (e) {
            }
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

