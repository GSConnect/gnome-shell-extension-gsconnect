"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "mpris",
    summary: _("Media Player Control"),
    description: _("Control MPRIS2 media players on your desktop"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Media-Player-Control-Plugin",
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
 * TODO: It's probably possible to grab a remote MPRIS2 player and mirror it
 *       over DBus locally...
 *       File bug on KDE Connect bug tracker about OpenURI wrt share plugin
 */

const DBusIface = '<node> \
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
</node>';
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);


var Plugin = new Lang.Class({
    Name: "GSConnectMPRISPlugin",
    Extends: PluginsBase.Plugin,
    
    _init: function (device) {
        this.parent(device, "mpris");
        
        this._listener = new DBusProxy(
            Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            Lang.bind(this, this._onDBusReady)
        );
        
        this._players = new Map();
    },

    _onDBusReady: function() {
        this._updatePlayers();
        
        this._listener.connectSignal(
            'NameOwnerChanged',
            Lang.bind(this, this._onNameOwnerChanged)
        );
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
            let mpris = new Common.DBusProxy.mpris(
                Gio.DBus.session,
                name,
                "/org/mpris/MediaPlayer2" 
            );
            
            if (!this._players.has(mpris.Identity)) {
                let player = new Common.DBusProxy.mprisPlayer(
                    Gio.DBus.session,
                    name,
                    "/org/mpris/MediaPlayer2" 
                );
                
                // TODO: this is pretty lazy, we just resend everything if
                //       anything changes
                //       position is not updating (might not matter though)
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
        
        // TODO: how to check this?
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
    }
});

