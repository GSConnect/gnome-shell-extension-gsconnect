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
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class Manager extends GObject.Object {

    _init() {
        super._init();

        this._setup();
    }

    get identities () {
        return Array.from(this.players.keys());
    }

    get players () {
        if (this._players === undefined) {
            this._players = new Map();
        }

        return this._players;
    }

    get paused() {
        if (this._paused === undefined) {
            this._paused = new Map();
        }

        return this._paused;
    }

    async _setup() {
        try {
            this._fdo = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: 'org.freedesktop.DBus',
                g_object_path: '/org/freedesktop/DBus'
            });

            await this._fdo.init_promise();

            // Watch for new players
            this._nameOwnerChangedId = this._fdo.connect(
                'g-signal',
                this._onGSignal.bind(this)
            );

            // Add the current players
            let names = await this._listNames();

            names.map(name => {
                if (name.startsWith('org.mpris.MediaPlayer2')) {
                    this._addPlayer(name);
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    _listNames() {
        return new Promise((resolve, reject) => {
            this._fdo.call(
                'org.freedesktop.DBus.ListNames',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        res = proxy.call_finish(res);
                        resolve(res.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _onGSignal(proxy, sender_name, signal_name, parameters) {
        try {
            if (signal_name === 'NameOwnerChanged') {
                this._onNameOwnerChanged(proxy, ...parameters.deep_unpack());
            }
        } catch (e) {
            logError(e);
        }
    }

    async _onNameOwnerChanged(proxy, name, old_owner, new_owner) {
        try {
            if (name.startsWith('org.mpris.MediaPlayer2')) {
                if (new_owner.length) {
                    this._addPlayer(name);
                } else {
                    this._removePlayer(name);
                }
            }
        } catch (e) {
            logError(e);
        }
    }

    async _addPlayer(name) {
        try {
            let mediaPlayer = new MediaPlayer2Proxy({
                g_connection: Gio.DBus.session,
                g_name: name,
                g_object_path: '/org/mpris/MediaPlayer2'
            });

            await mediaPlayer.init_promise();

            if (!this.players.has(mediaPlayer.Identity)) {
                debug(`Adding MPRIS Player ${mediaPlayer.Identity}`);

                let player = new PlayerProxy({
                    g_connection: Gio.DBus.session,
                    g_name: name,
                    g_object_path: '/org/mpris/MediaPlayer2',
                    proxy_flags: DBus.ProxyFlags.DO_NOT_CACHE_PROPERTIES
                });

                await player.init_promise()

                player.Identity = mediaPlayer.Identity.slice(0);

                player._propertiesId = player.connect(
                    'g-properties-changed',
                    (player) => this.emit('player-changed', player)
                );

                player._seekedId = player.connect(
                    'Seeked',
                    (player) => this.emit('player-changed', player)
                );

                this.players.set(player.Identity, player);
                this.notify('players');
            }
        } catch (e) {
            logError(e);
        }
    }

    async _removePlayer(name) {
        try {
            for (let [identity, player] of this.players.entries()) {
                if (player.g_name === name) {
                    debug(`Removing MPRIS Player ${identity}`);

                    player.disconnect(player._propertiesId);
                    player.disconnect(player._seekedId);
                    player.destroy();

                    this.paused.delete(identity);
                    this.players.delete(identity);
                    this.notify('players');
                }
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * A convenience function for pausing all players currently playing.
     */
    pauseAll() {
        for (let [identity, player] of this.players.entries()) {
            if (player.PlaybackStatus === 'Playing' && player.CanPause) {
                player.Pause();
                this.paused.set(identity, player);
            }
        }
    }

    /**
     * A convenience function for restarting all players paused with pauseAll().
     */
    unpauseAll() {
        for (let [identity, player] of this.paused.entries()) {
            if (player.PlaybackStatus === 'Paused' && player.CanPlay) {
                player.Play();
            }
        }

        this.paused.clear();
    }

    destroy() {
        this._fdo.disconnect(this._nameOwnerChangedId);
        this._fdo.destroy();

        for (let player of this.players.values()) {
            player.disconnect(player._propertiesId);
            player.disconnect(player._seekedId);
            player.destroy();
        }
    }
});

