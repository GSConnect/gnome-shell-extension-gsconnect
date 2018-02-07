"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;


const DBusXML = '<node> \
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
const DBusProxy = new Gio.DBusProxy.makeProxyWrapper(DBusXML);


const MediaPlayer2Node = Gio.DBusNodeInfo.new_for_xml(
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
</node>'
);
const MediaPlayer2Iface = MediaPlayer2Node.lookup_interface("org.mpris.MediaPlayer2");
const PlayerIface = MediaPlayer2Node.lookup_interface("org.mpris.MediaPlayer2.Player");


/**
 * Default
 */
var _default;

function get_default() {
    if (!_default) {
        _default = new Manager();
    }

    return _default;
};


/**
 * org.mpris.MediaPlayer2 Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Media_Player.html
 */
var MediaPlayer2Proxy = new Lang.Class({
    Name: "GSConnectMPRISPlayerClass",
    Extends: DBus.ProxyBase,
    Properties: {
        "CanQuit": GObject.ParamSpec.boolean(
            "CanQuit",
            "CanQuit",
            "If false, calling Quit will have no effect",
            GObject.ParamFlags.READABLE,
            false
        ),
        "Fullscreen": GObject.ParamSpec.boolean(
            "Fullscreen",
            "Fullscreen",
            "Whether the media player is occupying the fullscreen",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanSetFullscreen": GObject.ParamSpec.boolean(
            "CanSetFullscreen",
            "CanSetFullscreen",
            "If false, attempting to set Fullscreen will have no effect",
            GObject.ParamFlags.READABLE,
            false
        ),
        "CanRaise": GObject.ParamSpec.boolean(
            "CanRaise",
            "CanRaise",
            "If false, calling Raise will have no effect",
            GObject.ParamFlags.READABLE,
            false
        ),
        "HasTrackList": GObject.ParamSpec.boolean(
            "HasTrackList",
            "HasTrackList",
            "Whether the object implements org.mpris.MediaPlayer2.TrackList",
            GObject.ParamFlags.READABLE,
            false
        ),
        "Identity": GObject.ParamSpec.string(
            "Identity",
            "Identity",
            "A friendly name to identify the media player to users",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "DesktopEntry": GObject.ParamSpec.string(
            "DesktopEntry",
            "DesktopEntry",
            "The basename of an installed .desktop file (eg. app id)",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "SupportedUriSchemes": GObject.param_spec_variant(
            "SupportedUriSchemes",
            "SupportedUriSchemes",
            "The URI schemes supported by the media player",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "SupportedMimeTypes": GObject.param_spec_variant(
            "SupportedMimeTypes",
            "SupportedMimeTypes",
            "The mime-types supported by the media player",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        // A custom property for the org.mpris.MediaPlayer2.Player interface
        "Player": GObject.ParamSpec.object(
            "Player",
            "Player Interface",
            "A DBus proxy for org.mpris.MediaPlayer2.Player",
            GObject.ParamFlags.READABLE,
            Gio.DBusProxy
        )
    },

    _init: function (g_name) {
        this.parent({
            g_connection: Gio.DBus.session,
            g_interface_info: MediaPlayer2Iface,
            g_interface_name: MediaPlayer2Iface.name,
            g_name: g_name, // "org.mpris.MediaPlayer2.GSConnect",
            g_object_path: "/org/mpris/MediaPlayer2"
        });

        this._wrapObject();
    },

    get Player() {
        if (!this._player) {
            this._player = new PlayerProxy(this.g_name);
        }

        return this._player;
    }
});


/**
 * org.mpris.MediaPlayer2.Player Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html
 */
var PlayerProxy = new Lang.Class({
    Name: "GSConnectMPRISPlayerProxy",
    Extends: DBus.ProxyBase,
    Properties: {
        // Playing | Paused | Stop
        "PlaybackStatus": GObject.ParamSpec.string(
            "PlaybackStatus",
            "PlayerPlaybackState",
            "The current playback status",
            GObject.ParamFlags.READABLE,
            ""
        ),
        // None | Track | Playlist
        "LoopStatus": GObject.ParamSpec.string(
            "LoopStatus",
            "PlayerLoopMode",
            "The current loop / repeat status",
            GObject.ParamFlags.READWRITE,
            ""
        ),
        // MinimumRate <-> MaximumRate && !0.0
        "Rate": GObject.ParamSpec.double(
            "Rate",
            "PlayerPlaybackRate",
            "The current playback rate",
            GObject.ParamFlags.READWRITE,
            0.1, 1.0,
            1.0
        ),
        "Shuffle": GObject.ParamSpec.boolean(
            "Shuffle",
            "PlayerShuffle",
            "Whether playback is progressing in a non-linear order",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "Metadata": GObject.param_spec_variant(
            "Metadata",
            "TrackMetadata",
            "The metadata of the current element",
            new GLib.VariantType("a{sv}"),
            null,
            GObject.ParamFlags.READABLE
        ),
        // 0.0 - 1.0 (?)
        "Volume": GObject.ParamSpec.double(
            "Volume",
            "PlayerVolume",
            "The volume level",
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            0.5
        ),
        //
        "Position": GObject.ParamSpec.int64(
            "Position",
            "PlayerTimeMicroseconds",
            "The volume level",
            GObject.ParamFlags.READABLE,
            new GLib.Variant("x", 0), new GLib.Variant("x", GLib.MAXINT64),
            new GLib.Variant("x", 0)
        ),
        // > 0.0, <= 1.0
        "MinimumRate": GObject.ParamSpec.double(
            "MinimumRate",
            "PlayerPlaybackRateMinimum",
            "The minimum value which the Rate property can take",
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            1.0
        ),
        // >= 1.0
        "MaximumRate": GObject.ParamSpec.double(
            "MaximumRate",
            "PlayerPlaybackRateMaximum",
            "The maximum value which the Rate property can take",
            GObject.ParamFlags.READWRITE,
            1.0, 100.0,
            1.0
        ),
        "CanGoNext": GObject.ParamSpec.boolean(
            "CanGoNext",
            "PlayerCanGoNext",
            "Whether the client can call the Next method on this interface",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanGoPrevious": GObject.ParamSpec.boolean(
            "CanGoPrevious",
            "PlayerCanGoPrevious",
            "Whether the client can call the Previous method on this interface",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanPlay": GObject.ParamSpec.boolean(
            "CanPlay",
            "PlayerCanPlay",
            "Whether playback can be started using Play or PlayPause",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanPause": GObject.ParamSpec.boolean(
            "CanPause",
            "PlayerCanPause",
            "Whether playback can be paused using Pause or PlayPause",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanSeek": GObject.ParamSpec.boolean(
            "CanSeek",
            "PlayerCanSeek",
            "Whether the client can control the playback position using Seek and SetPosition",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "CanControl": GObject.ParamSpec.boolean(
            "CanControl",
            "PlayerCanControl",
            "Whether the media player may be controlled over this interface",
            GObject.ParamFlags.READWRITE,
            false
        )
    },
    Signals: {
        "Seeked": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_INT64 ]
        }
    },

    _init: function (busName) {
        this.parent({
            g_connection: Gio.DBus.session,
            g_interface_info: PlayerIface,
            g_interface_name: PlayerIface.name,
            g_name: busName,
            g_object_path: "/org/mpris/MediaPlayer2"
        });

        this._wrapObject();
    },

    Next: function () {
        if (this._proxy) {
            return this._proxy._call("Next");
        } else {
        }
    },

    Previous: function () {
        if (this._proxy) {
            return this._proxy._call("Previous");
        } else {
        }
    },

    Pause: function () {
        if (this._proxy) {
            return this._proxy._call("Pause");
        } else {
        }
    },

    PlayPause: function () {
        if (this._proxy) {
            return this._proxy._call("PlayPause");
        } else {
        }
    },

    Stop: function () {
        if (this._proxy) {
            return this._proxy._call("Stop");
        } else {
        }
    },

    Play: function () {
        if (this._proxy) {
            return this._proxy._call("Play");
        } else {
        }
    },

    OpenUri: function (uri) {
        if (this._proxy) {
            this._proxy._call("OpenUri", uri);
        } else {
        }
    },

    Seek: function (position) {
        if (this._proxy) {
            this._proxy._call("Seek", position);
        } else {
        }
    },

    SetPosition: function (track, position) {
        if (this._proxy) {
            this._proxy._call("SetPosition", track, position);
        } else {
        }
    }
});


var Manager = new Lang.Class({
    Name: "GSConnectMPRISManager",
    Extends: GObject.Object,
    Properties: {
        "identities": GObject.param_spec_variant(
            "identities",
            "IdentityList",
            "A list of MediaPlayer2.Identity for each player",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        // Actually returns an Object of MediaPlayer2Proxy objects,
        // Player.Identity as key
        "players": GObject.param_spec_variant(
            "players",
            "PlayerList",
            "A list of known devices",
            new GLib.VariantType("a{sv}"),
            new GLib.Variant("a{sv}", {}),
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        "player-changed": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT, GObject.TYPE_VARIANT ]
        }
    },

    _init: function () {
        this.parent();

        try {
            this._players = {};

            this._fdo = new DBus.get_default();
            this._fdo.connect("NameOwnerChanged", (proxy, name, oldOwner, newOwner) => {
                if (name.startsWith("org.mpris.MediaPlayer2")) {
                    this._updatePlayers();
                }
            });
            this._updatePlayers();
        } catch (e) {
            debug("MPRIS ERROR: " + e);
        }
    },

    get identities () {
        return Array.from(Object.keys(this._players));
    },

    get players () {
        return this._players;
    },

    _onNameOwnerChanged: function(proxy, name, oldOwner, newOwner) {
        if (name.startsWith("org.mpris.MediaPlayer2")) {
            this._updatePlayers();
        }
    },

    _updatePlayers: function () {
        debug("MPRIS: _updatePlayers()");

        // Add new players
        this._fdo.ListNames().then(names => {
            for (let busName of names) {
                if (busName.startsWith("org.mpris.MediaPlayer2")) {
                    log("BUSNAME: " + busName);
                    let mediaPlayer = new MediaPlayer2Proxy(busName);

                    if (!this._players[mediaPlayer.Identity]) {
                        mediaPlayer.Player.connect("notify", (player, properties) => {
                            this.emit(
                                "player-changed",
                                player,
                                new GLib.Variant("as", [])
                            );
                        });
                        mediaPlayer.Player.connect("Seeked", (player) => {
                            this.emit(
                                "player-changed",
                                player,
                                new GLib.Variant("as", ["Position"])
                            );
                        });

                        // FIXME: hack
                        mediaPlayer.Player.Identity = mediaPlayer.Identity;

                        this.players[mediaPlayer.Identity] = mediaPlayer.Player;
                    }
                }
            }
        }).catch(e => {
            debug(e);
        });

        // FIXME: gName/g_name undefined
        // Remove old players
//        for (let [name, proxy] of this._players.entries()) {
//            if (players.indexOf(proxy.g_name) < 0) {
//                GObject.signal_handlers_destroy(proxy);
//                this._players.delete(name);
//            }
//        }

        this.notify("players");
    },

    destroy: function () {
        try {
            this._listener.disconnectSignal(this._nameOwnerChanged);
        } catch (e) {
        }

        for (let proxy of Object.values(this._players)) {
            try {
                GObject.signal_handlers_destroy(proxy);
            } catch (e) {
            }
        }
    }
});

