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

const MPRISXML = '<node> \
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
</node>'
const MPRISProxy = new Gio.DBusProxy.makeProxyWrapper(MPRISXML);

const MPRISPlayerXML = '<node> \
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
const MPRISPlayerProxy = new Gio.DBusProxy.makeProxyWrapper(MPRISPlayerXML);
const MPRISPlayerNode = Gio.DBusNodeInfo.new_for_xml(MPRISPlayerXML);
const MPRISPlayerIface = MPRISPlayerNode.lookup_interface("org.mpris.MediaPlayer2.Player");


function getManager () {
    if (!this._manager) {
        this._manager = new Manager();
    }

    return this._manager;
};


/**
 * MPRIS Player Class
 * https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html
 */
var MediaPlayer = new Lang.Class({
    Name: "GSConnectMPRISPlayerClass",
    Extends: GObject.Object,
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
            0.1,
            1.0,
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
            0.0,
            1.0,
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
            0.0,
            1.0,
            1.0
        ),
        // >= 1.0
        "MaximumRate": GObject.ParamSpec.double(
            "MaximumRate",
            "PlayerPlaybackRateMaximum",
            "The maximum value which the Rate property can take",
            GObject.ParamFlags.READWRITE,
            1.0,
            100.0,
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

    _init: function (params) {
        this.parent();

        this.identity = params.identity;

        // We're proxying a remote player
        if (params.mprisObj) {
            this._dbus = log();
            this._dbus = Gio.DBusExportedObject.wrapJSObject(
                //g_name: "org.mpris.MediaPlayer2.GSConnect", // FIXME
                gsconnect.dbusinfo.lookup_interface(
                    "org.gnome.Shell.Extensions.GSConnect.Device"
                ),
                mprisObj
            );
            this._dbus.export(Gio.DBus.session, "/org/mpris/MediaPlayer2");
        // We're proxying a local player
        } else {
            this._proxy = new DBus.ProxyBase({
                g_connection: Gio.DBus.session,
                g_interface_info: MPRISPlayerIface,
                g_interface_name: MPRISPlayerIface.name,
                g_name: params.g_name, // "org.mpris.MediaPlayer2.GSConnect",
                g_object_path: "/org/mpris/MediaPlayer2"
            });

            // Properties
            //this._proxy._wrapProperties();
            for (let property of MPRISPlayerIface.properties) {
                let name = property.name;
                let signature = property.signature;

                Object.defineProperty(this, name, {
                    get: () => this._proxy._get(name, signature),
                    set: (value) => this._proxy._set(name, value, signature),
                    configurable: true,
                    enumerable: true
                });
            }
            this._proxy.connect("g-properties-changed", (proxy, properties) => {
                for (let name in properties.deep_unpack()) {
                    this.notify(name);
                }
            });

            // Signals
            this._proxy.connect("g-signal", (proxy, name, parameters) => {
                this.emit(name, ...parameters.deep_unpack());
            });
        }
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
        "names": GObject.param_spec_variant(
            "devices",
            "DevicesList",
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "players": GObject.param_spec_variant(
            "players",
            "DevicesList",
            "A list of known devices",
            new GLib.VariantType("as"),
            null,
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
            this._players = new Map();

            this._listener = new DBusProxy(
                Gio.DBus.session,
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                (proxy, error) => {
                    if (error === null) {
                        this._nameOwnerChanged = proxy.connectSignal(
                            'NameOwnerChanged',
                            Lang.bind(this, this._onNameOwnerChanged)
                        );
                        this._updatePlayers();
                    }
                }
            );
        } catch (e) {
            debug("MPRIS ERROR: " + e);
        }
    },

    get names () {
        return Array.from(this._players.keys());
    },

    get players () {
        return Array.from(this._players.values());
    },

    _onNameOwnerChanged: function(proxy, sender, [name, oldOwner, newOwner]) {
        if (name.startsWith("org.mpris.MediaPlayer2")) {
            this._updatePlayers();
        }
    },

    _listPlayers: function () {
        debug("MPRIS: _listPlayers()");

        let players = [];

        for (let name of this._listener.ListNamesSync()[0]) {

            if (name.indexOf("org.mpris.MediaPlayer2") > -1) {
                players.push(name);
            }
        }

        return players;
    },

    _updatePlayers: function () {
        debug("MPRIS: _updatePlayers()");

        let players = this._listPlayers();

        // Add new players
        for (let name of players) {
            let mpris = MPRISProxy(
                Gio.DBus.session,
                name,
                "/org/mpris/MediaPlayer2"
            );

            if (!this._players.has(mpris.Identity)) {
                let player = new MediaPlayer({
                    g_name: name,
                    identity: mpris.Identity
                });

                // TODO: resending everything if anything changes
                player._proxy.connect("g-properties-changed", (player, properties) => {
                    this.emit("player-changed", player, properties);
                });

                this._players.set(mpris.Identity, player);
            }
        }

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

        for (let proxy of this._players.values()) {
            try {
                GObject.signal_handlers_destroy(proxy);
            } catch (e) {
            }
        }
    }
});

