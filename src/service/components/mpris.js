'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const DBus = imports.service.components.dbus;


/**
 * org.mpris.MediaPlayer2 Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Media_Player.html
 */
const MediaPlayer2Proxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2')
);


/**
 * org.mpris.MediaPlayer2.Player Proxy
 * https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html
 */
const PlayerProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2.Player')
);


var Manager = GObject.registerClass({
    GTypeName: 'GSConnectMPRISManager',
    Implements: [Gio.DBusInterface],
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
            param_types: [GObject.TYPE_OBJECT]
        },
        'player-seeked': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_OBJECT]
        }
    }
}, class Manager extends Gio.DBusProxy {

    _init() {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.freedesktop.DBus',
            g_object_path: '/org/freedesktop/DBus'
        });

        // Asynchronous setup
        this._init_async();
    }

    async _init_async() {
        try {
            await this.init_promise();

            // Add the current players
            let names = await this._listNames();
            
            for (let i = 0, len = names.length; i < len; i++) {
                let name = names[i];

                if (name.startsWith('org.mpris.MediaPlayer2')) {
                    this._addPlayer(name);
                }
            }
        } catch (e) {
            // FIXME: if something goes wrong the component will appear active
            logError(e);
            this.destroy();
        }
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

    get service() {
        return Gio.Application.get_default();
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        try {
            if (signal_name === 'NameOwnerChanged') {
                let [name, old_owner, new_owner] = parameters.deep_unpack();

                if (name.startsWith('org.mpris.MediaPlayer2')) {
                    if (new_owner.length) {
                        this._addPlayer(name);
                    } else if (old_owner.length) {
                        this._removePlayer(name);
                    }
                }
            }
        } catch (e) {
            debug(e);
        }
    }

    _listNames() {
        return new Promise((resolve, reject) => {
            this.call(
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

    async _addPlayer(name) {
        try {
            let mediaPlayer = await new MediaPlayer2Proxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: name,
                g_object_path: '/org/mpris/MediaPlayer2'
            }).init_promise();

            if (!this.players.has(mediaPlayer.Identity)) {
                debug(`Adding MPRIS Player ${mediaPlayer.Identity}`);

                let player = await new PlayerProxy({
                    g_bus_type: Gio.BusType.SESSION,
                    g_name: name,
                    g_object_path: '/org/mpris/MediaPlayer2',
                    no_cache: true
                }).init_promise();

                player.Identity = mediaPlayer.Identity.slice(0);

                player._propertiesId = player.connect(
                    'g-properties-changed',
                    (player) => this.emit('player-changed', player)
                );

                player._seekedId = player.connect(
                    'Seeked',
                    (player) => this.emit('player-seeked', player)
                );

                this.players.set(player.Identity, player);
                this.notify('players');
            }
        } catch (e) {
            debug(e);
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
            debug(e);
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
        for (let player of this.paused.values()) {
            if (player.PlaybackStatus === 'Paused' && player.CanPlay) {
                player.Play();
            }
        }

        this.paused.clear();
    }

    destroy() {
        for (let player of this.players.values()) {
            player.disconnect(player._propertiesId);
            player.disconnect(player._seekedId);
            player.destroy();
        }

        GObject.signal_handlers_destroy(this);
    }
});


/**
 * The service class for this component
 */
var Service = Manager;

