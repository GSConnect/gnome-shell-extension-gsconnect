'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

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
    gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2')
);


/**
 * org.mpris.MediaPlayer2.Player Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html
 */
var PlayerProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2.Player')
);


var Manager = GObject.registerClass({
    GTypeName: 'GSConnectMPRISManager',
    Properties: {
        'identities': GObject.param_spec_variant(
            'identities',
            'IdentityList',
            'A list of MediaPlayer2.Identity for each player',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        // Actually returns an Object of MediaPlayer2Proxy objects,
        // Player.Identity as key
        'players': GObject.param_spec_variant(
            'players',
            'PlayerList',
            'A list of known devices',
            new GLib.VariantType('a{sv}'),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        'player-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT, GObject.TYPE_VARIANT ]
        }
    }
}, class Manager extends GObject.Object {

    _init() {
        super._init();

        new DBus.FdoProxy({
            g_connection: Gio.DBus.session,
            g_name: 'org.freedesktop.DBus',
            g_object_path: '/org/freedesktop/DBus'
        }).init_promise().then(proxy => {
            this._fdo = proxy;

            this._nameOwnerChangedId = proxy.connect(
                'NameOwnerChanged',
                this._onNameOwnerChanged.bind(this)
            );

            return proxy.ListNames();
        }).then(names => {
            names.map(name => {
                if (name.startsWith('org.mpris.MediaPlayer2')) {
                    this._addPlayer(name);
                }
            });

            return;
        }).catch(debug);
    }

    get identities () {
        return Array.from(this.players.keys());
    }

    get players () {
        if (!this._players) {
            this._players = new Map();
        }

        return this._players;
    }

    _onNameOwnerChanged(fdo, name, old_owner, new_owner) {
        if (name.startsWith('org.mpris.MediaPlayer2')) {
            if (new_owner.length) {
                this._addPlayer(name);
            } else {
                for (let mediaPlayer of this.players.values()) {
                    if (mediaPlayer.g_name === old_owner) {
                        this._removePlayer(mediaPlayer);
                        break;
                    }
                }
            }
        }
    }

    _addPlayer(busName) {
        let mediaPlayer = new MediaPlayer2Proxy({
            g_connection: Gio.DBus.session,
            g_name: busName,
            g_object_path: '/org/mpris/MediaPlayer2'
        });
        mediaPlayer.init(null);

        if (!this.players.has(mediaPlayer.Identity)) {
            debug(`Adding MPRIS Player ${mediaPlayer.Identity}`);

            mediaPlayer.Player = new PlayerProxy({
                g_connection: Gio.DBus.session,
                g_name: busName,
                g_object_path: '/org/mpris/MediaPlayer2'
            });
            mediaPlayer.Player.init(null);

            mediaPlayer.Player._propertiesId = mediaPlayer.Player.connect(
                'notify',
                (player) => {
                    this.emit(
                        'player-changed',
                        mediaPlayer,
                        new GLib.Variant('as', [])
                    );
                }
            );

            mediaPlayer.Player._seekedId = mediaPlayer.Player.connect(
                'Seeked',
                (player) => {
                    this.emit(
                        'player-changed',
                        mediaPlayer,
                        new GLib.Variant('as', ['Position'])
                    );
                }
            );

            this.players.set(mediaPlayer.Identity, mediaPlayer);
            this.notify('players');
        } else {
            mediaPlayer.destroy();
        }
    }

    _removePlayer(mediaPlayer) {
        if (this.players.has(mediaPlayer.Identity)) {
            debug(`Removing MPRIS Player ${mediaPlayer.Identity}`);

            let name = mediaPlayer.Identity;

            mediaPlayer.Player.disconnect(mediaPlayer.Player._propertiesId);
            mediaPlayer.Player.disconnect(mediaPlayer.Player._seekedId);
            mediaPlayer.Player.destroy();
            mediaPlayer.destroy();

            this.players.delete(name);
            this.notify('players');
        }
    }

    destroy() {
        this._fdo.disconnect(this._nameOwnerChangedId);

        for (let mediaPlayer of this.players.values()) {
            this._removePlayer(mediaPlayer);
        }
    }
});

