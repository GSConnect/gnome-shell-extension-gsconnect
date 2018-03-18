"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;


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
var MediaPlayer2Proxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface("org.mpris.MediaPlayer2")
);


/**
 * org.mpris.MediaPlayer2.Player Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html
 */
var PlayerProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface("org.mpris.MediaPlayer2.Player")
);


var Manager = GObject.registerClass({
    GTypeName: "GSConnectMPRISManager",
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
    }
}, class Manager extends GObject.Object {

    _init() {
        super._init();

        try {
            this._fdo = new DBus.FdoProxy({
                g_connection: Gio.DBus.session,
                g_name: "org.freedesktop.DBus",
                g_object_path: "/"
            });

            this._fdo.init_promise().then(result => {
                this._nameOwnerChanged = this._fdo.connect(
                    "name-owner-changed",
                    (proxy, name, oldOwner, newOwner) => {
                        if (name.startsWith("org.mpris.MediaPlayer2")) {
                            this._updatePlayers();
                        }
                    }
                );
                this._updatePlayers();
            });
        } catch (e) {
            debug("MPRIS ERROR: " + e);
        }
    }

    get identities () {
        return Array.from(Object.keys(this.players));
    }

    get players () {
        if (!this._players) {
            this._players = {};
        }

        return this._players;
    }

    // FIXME: could actually use this
    _onNameOwnerChanged(proxy, name, oldOwner, newOwner) {
        if (name.startsWith("org.mpris.MediaPlayer2")) {
            this._updatePlayers();
        }
    }

    _addPlayer() {
    }

    _removePlayer() {
    }

    _updatePlayers() {
        debug("MPRIS: _updatePlayers()");

        // Add new players
        this._fdo.listNames().then(names => {
            names = names.filter(n => n.startsWith("org.mpris.MediaPlayer2"));
            log("NAMES: " + names);

            for (let busName of names) {
                let mediaPlayer = new MediaPlayer2Proxy({
                    g_connection: Gio.DBus.session,
                    g_name: busName,
                    g_object_path: "/org/mpris/MediaPlayer2"
                });

                mediaPlayer.Player = new PlayerProxy({
                    g_connection: Gio.DBus.session,
                    g_name: busName,
                    g_object_path: "/org/mpris/MediaPlayer2"
                });

                if (!this._players[mediaPlayer.identity]) {
                    mediaPlayer.Player.connect("notify", (player, properties) => {
                        this.emit(
                            "player-changed",
                            mediaPlayer,
                            new GLib.Variant("as", [])
                        );
                    });
                    mediaPlayer.Player.connect("seeked", (player) => {
                        this.emit(
                            "player-changed",
                            mediaPlayer,
                            new GLib.Variant("as", ["Position"])
                        );
                    });

                    this.players[mediaPlayer.Identity] = mediaPlayer;
                }
            }

            // Remove old players
            // TODO: use NameOwnerChanged
            for (let name in this.players) {
                debug("removing player '" + name + "'");
                let player = this.players[name];

                if (names.indexOf(player.g_name) < 0) {
                    player.destroy();
                    delete this.players[name];
                }
            }
        // Better
        }).catch(e => {
            debug(e);
        });

        this.notify("players");
    }

    destroy() {
        this._fdo.disconnect(this._nameOwnerChanged);

        for (let proxy of Object.values(this._players)) {
            proxy.destroy()
        }
    }
});

