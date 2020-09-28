'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


var Player = GObject.registerClass({
    GTypeName: 'GSConnectMediaPlayerInterface',
    Properties: {
        // Application Properties
        'CanQuit': GObject.ParamSpec.boolean(
            'CanQuit',
            'Can Quit',
            'Whether the client can call the Quit method.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'Fullscreen': GObject.ParamSpec.boolean(
            'Fullscreen',
            'Fullscreen',
            'Whether the player is in fullscreen mode.',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'CanSetFullscreen': GObject.ParamSpec.boolean(
            'CanSetFullscreen',
            'Can Set Fullscreen',
            'Whether the client can set the Fullscreen property.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanRaise': GObject.ParamSpec.boolean(
            'CanRaise',
            'Can Raise',
            'Whether the client can call the Raise method.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'HasTrackList': GObject.ParamSpec.boolean(
            'HasTrackList',
            'Has Track List',
            'Whether the player has a track list.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'Identity': GObject.ParamSpec.string(
            'Identity',
            'Identity',
            'The application name.',
            GObject.ParamFlags.READABLE,
            null
        ),
        'DesktopEntry': GObject.ParamSpec.string(
            'DesktopEntry',
            'DesktopEntry',
            'The basename of an installed .desktop file.',
            GObject.ParamFlags.READABLE,
            null
        ),
        'SupportedUriSchemes': GObject.param_spec_variant(
            'SupportedUriSchemes',
            'Supported URI Schemes',
            'The URI schemes supported by the media player.',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'SupportedMimeTypes': GObject.param_spec_variant(
            'SupportedMimeTypes',
            'Supported MIME Types',
            'The mime-types supported by the media player.',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),

        // Player Properties
        'PlaybackStatus': GObject.ParamSpec.string(
            'PlaybackStatus',
            'Playback Status',
            'The current playback status.',
            GObject.ParamFlags.READABLE,
            null
        ),
        'LoopStatus': GObject.ParamSpec.string(
            'LoopStatus',
            'Loop Status',
            'The current loop status.',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'Rate': GObject.ParamSpec.double(
            'Rate',
            'Rate',
            'The current playback rate.',
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            1.0
        ),
        'MinimumRate': GObject.ParamSpec.double(
            'MinimumRate',
            'Minimum Rate',
            'The minimum playback rate.',
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            1.0
        ),
        'MaximimRate': GObject.ParamSpec.double(
            'MaximumRate',
            'Maximum Rate',
            'The maximum playback rate.',
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            1.0
        ),
        'Shuffle': GObject.ParamSpec.boolean(
            'Shuffle',
            'Shuffle',
            'Whether track changes are linear.',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'Metadata': GObject.param_spec_variant(
            'Metadata',
            'Metadata',
            'The metadata of the current element.',
            new GLib.VariantType('a{sv}'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'Volume': GObject.ParamSpec.double(
            'Volume',
            'Volume',
            'The volume level.',
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            1.0
        ),
        'Position': GObject.ParamSpec.int64(
            'Position',
            'Position',
            'The current track position in microseconds.',
            GObject.ParamFlags.READABLE,
            0, Number.MAX_SAFE_INTEGER,
            0
        ),
        'CanGoNext': GObject.ParamSpec.boolean(
            'CanGoNext',
            'Can Go Next',
            'Whether the client can call the Next method.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanGoPrevious': GObject.ParamSpec.boolean(
            'CanGoPrevious',
            'Can Go Previous',
            'Whether the client can call the Previous method.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanPlay': GObject.ParamSpec.boolean(
            'CanPlay',
            'Can Play',
            'Whether playback can be started using Play or PlayPause.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanPause': GObject.ParamSpec.boolean(
            'CanPause',
            'Can Pause',
            'Whether playback can be paused using Play or PlayPause.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanSeek': GObject.ParamSpec.boolean(
            'CanSeek',
            'Can Seek',
            'Whether the client can control the playback position using Seek and SetPosition.',
            GObject.ParamFlags.READABLE,
            false
        ),
        'CanControl': GObject.ParamSpec.boolean(
            'CanControl',
            'Can Control',
            'Whether the media player may be controlled over this interface.',
            GObject.ParamFlags.READABLE,
            false
        ),
    },
    Signals: {
        'Seeked': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_INT64],
        },
    },
}, class Player extends GObject.Object {

    /*
     * The org.mpris.MediaPlayer2 Interface
     */
    get CanQuit() {
        if (this._CanQuit === undefined)
            this._CanQuit = false;

        return this._CanQuit;
    }

    get CanRaise() {
        if (this._CanRaise === undefined)
            this._CanRaise = false;

        return this._CanRaise;
    }

    get CanSetFullscreen() {
        if (this._CanFullscreen === undefined)
            this._CanFullscreen = false;

        return this._CanFullscreen;
    }

    get DesktopEntry() {
        if (this._DesktopEntry === undefined)
            return 'org.gnome.Shell.Extensions.GSConnect';

        return this._DesktopEntry;
    }

    get Fullscreen() {
        if (this._Fullscreen === undefined)
            this._Fullscreen = false;

        return this._Fullscreen;
    }

    set Fullscreen(mode) {
        if (this.Fullscreen === mode)
            return;

        this._Fullscreen = mode;
        this.notify('Fullscreen');
    }

    get HasTrackList() {
        if (this._HasTrackList === undefined)
            this._HasTrackList = false;

        return this._HasTrackList;
    }

    get Identity() {
        if (this._Identity === undefined)
            this._Identity = '';

        return this._Identity;
    }

    get SupportedMimeTypes() {
        if (this._SupportedMimeTypes === undefined)
            this._SupportedMimeTypes = [];

        return this._SupportedMimeTypes;
    }

    get SupportedUriSchemes() {
        if (this._SupportedUriSchemes === undefined)
            this._SupportedUriSchemes = [];

        return this._SupportedUriSchemes;
    }

    Quit() {
        throw new GObject.NotImplementedError();
    }

    Raise() {
        throw new GObject.NotImplementedError();
    }

    /*
     * The org.mpris.MediaPlayer2.Player Interface
     */
    get CanControl() {
        if (this._CanControl === undefined)
            this._CanControl = false;

        return this._CanControl;
    }

    get CanGoNext() {
        if (this._CanGoNext === undefined)
            this._CanGoNext = false;

        return this._CanGoNext;
    }

    get CanGoPrevious() {
        if (this._CanGoPrevious === undefined)
            this._CanGoPrevious = false;

        return this._CanGoPrevious;
    }

    get CanPause() {
        if (this._CanPause === undefined)
            this._CanPause = false;

        return this._CanPause;
    }

    get CanPlay() {
        if (this._CanPlay === undefined)
            this._CanPlay = false;

        return this._CanPlay;
    }

    get CanSeek() {
        if (this._CanSeek === undefined)
            this._CanSeek = false;

        return this._CanSeek;
    }

    get LoopStatus() {
        if (this._LoopStatus === undefined)
            this._LoopStatus = 'None';

        return this._LoopStatus;
    }

    set LoopStatus(status) {
        if (this.LoopStatus === status)
            return;

        this._LoopStatus = status;
        this.notify('LoopStatus');
    }

    get MaximumRate() {
        if (this._MaximumRate === undefined)
            this._MaximumRate = 1.0;

        return this._MaximumRate;
    }

    get Metadata() {
        if (this._Metadata === undefined) {
            this._Metadata = {
                'xesam:artist': [_('Unknown')],
                'xesam:album': _('Unknown'),
                'xesam:title': _('Unknown'),
                'mpris:length': 0,
            };
        }

        return this._Metadata;
    }

    get MinimumRate() {
        if (this._MinimumRate === undefined)
            this._MinimumRate = 1.0;

        return this._MinimumRate;
    }

    get PlaybackStatus() {
        if (this._PlaybackStatus === undefined)
            this._PlaybackStatus = 'Stopped';

        return this._PlaybackStatus;
    }

    get Position() {
        if (this._Position === undefined)
            this._Position = 0;

        return this._Position;
    }

    get Rate() {
        if (this._Rate === undefined)
            this._Rate = 1.0;

        return this._Rate;
    }

    set Rate(rate) {
        if (this.Rate === rate)
            return;

        this._Rate = rate;
        this.notify('Rate');
    }

    get Shuffle() {
        if (this._Shuffle === undefined)
            this._Shuffle = false;

        return this._Shuffle;
    }

    set Shuffle(mode) {
        if (this.Shuffle === mode)
            return;

        this._Shuffle = mode;
        this.notify('Shuffle');
    }

    get Volume() {
        if (this._Volume === undefined)
            this._Volume = 1.0;

        return this._Volume;
    }

    set Volume(level) {
        if (this.Volume === level)
            return;

        this._Volume = level;
        this.notify('Volume');
    }

    Next() {
        throw new GObject.NotImplementedError();
    }

    OpenUri(uri) {
        throw new GObject.NotImplementedError();
    }

    Previous() {
        throw new GObject.NotImplementedError();
    }

    Pause() {
        throw new GObject.NotImplementedError();
    }

    Play() {
        throw new GObject.NotImplementedError();
    }

    PlayPause() {
        throw new GObject.NotImplementedError();
    }

    Seek(offset) {
        throw new GObject.NotImplementedError();
    }

    SetPosition(trackId, position) {
        throw new GObject.NotImplementedError();
    }

    Stop() {
        throw new GObject.NotImplementedError();
    }
});


/**
 * An aggregate of the org.mpris.MediaPlayer2 and org.mpris.MediaPlayer2.Player
 * interfaces.
 */
const PlayerProxy = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlayer',
}, class PlayerProxy extends Player {

    _init(name) {
        super._init();

        this._application = new Gio.DBusProxy({
            g_bus_type: Gio.BusType.SESSION,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2',
        });

        this._applicationChangedId = this._application.connect(
            'g-properties-changed',
            this._onPropertiesChanged.bind(this)
        );

        this._player = new Gio.DBusProxy({
            g_bus_type: Gio.BusType.SESSION,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2.Player',
        });

        this._playerChangedId = this._player.connect(
            'g-properties-changed',
            this._onPropertiesChanged.bind(this)
        );

        this._playerSignalId = this._player.connect(
            'g-signal',
            this._onSignal.bind(this)
        );

        this._cancellable = new Gio.Cancellable();
    }

    _onSignal(proxy, sender_name, signal_name, parameters) {
        try {
            if (signal_name !== 'Seeked')
                return;

            this.emit('Seeked', parameters.deepUnpack()[0]);
        } catch (e) {
            debug(e, proxy.g_name);
        }
    }

    _call(proxy, name, parameters = null) {
        proxy.call(
            name,
            parameters,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            this._cancellable,
            (proxy, result) => {
                try {
                    proxy.call_finish(result);
                } catch (e) {
                    Gio.DBusError.strip_remote_error(e);
                    debug(e, proxy.g_name);
                }
            }
        );
    }

    _get(proxy, name, fallback = null) {
        try {
            return proxy.get_cached_property(name).recursiveUnpack();
        } catch (e) {
            return fallback;
        }
    }

    _set(proxy, name, value) {
        try {
            proxy.set_cached_property(name, value);

            proxy.call(
                'org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [proxy.g_interface_name, name, value]),
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                this._cancellable,
                (proxy, result) => {
                    try {
                        proxy.call_finish(result);
                    } catch (e) {
                        Gio.DBusError.strip_remote_error(e);
                        debug(e, proxy.g_name);
                    }
                }
            );
        } catch (e) {
            debug(e, proxy.g_name);
        }
    }

    _onPropertiesChanged(proxy, changed, invalidated) {
        try {
            this.freeze_notify();

            for (const name in changed.deepUnpack())
                this.notify(name);

            this.thaw_notify();
        } catch (e) {
            debug(e, proxy.g_name);
        }
    }

    initPromise() {
        const application = new Promise((resolve, reject) => {
            this._application.init_async(0, this._cancellable, (proxy, res) => {
                try {
                    resolve(proxy.init_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        const player = new Promise((resolve, reject) => {
            this._player.init_async(0, this._cancellable, (proxy, res) => {
                try {
                    resolve(proxy.init_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        return Promise.all([application, player]);
    }

    /*
     * The org.mpris.MediaPlayer2 Interface
     */
    get CanQuit() {
        return this._get(this._application, 'CanQuit', false);
    }

    get CanRaise() {
        return this._get(this._application, 'CanRaise', false);
    }

    get CanSetFullscreen() {
        return this._get(this._application, 'CanSetFullscreen', false);
    }

    get DesktopEntry() {
        return this._get(this._application, 'DesktopEntry', null);
    }

    get Fullscreen() {
        return this._get(this._application, 'Fullscreen', false);
    }

    set Fullscreen(mode) {
        this._set(this._application, 'Fullscreen', new GLib.Variant('b', mode));
    }

    get HasTrackList() {
        return this._get(this._application, 'HasTrackList', false);
    }

    get Identity() {
        return this._get(this._application, 'Identity', _('Unknown'));
    }

    get SupportedMimeTypes() {
        return this._get(this._application, 'SupportedMimeTypes', []);
    }

    get SupportedUriSchemes() {
        return this._get(this._application, 'SupportedUriSchemes', []);
    }

    Quit() {
        this._call(this._application, 'Quit');
    }

    Raise() {
        this._call(this._application, 'Raise');
    }

    /*
     * The org.mpris.MediaPlayer2.Player Interface
     */
    get CanControl() {
        return this._get(this._player, 'CanControl', false);
    }

    get CanGoNext() {
        return this._get(this._player, 'CanGoNext', false);
    }

    get CanGoPrevious() {
        return this._get(this._player, 'CanGoPrevious', false);
    }

    get CanPause() {
        return this._get(this._player, 'CanPause', false);
    }

    get CanPlay() {
        return this._get(this._player, 'CanPlay', false);
    }

    get CanSeek() {
        return this._get(this._player, 'CanSeek', false);
    }

    get LoopStatus() {
        return this._get(this._player, 'LoopStatus', 'None');
    }

    set LoopStatus(status) {
        this._set(this._player, 'LoopStatus', new GLib.Variant('s', status));
    }

    get MaximumRate() {
        return this._get(this._player, 'MaximumRate', 1.0);
    }

    get Metadata() {
        if (this._metadata === undefined) {
            this._metadata = {
                'xesam:artist': [_('Unknown')],
                'xesam:album': _('Unknown'),
                'xesam:title': _('Unknown'),
                'mpris:length': 0,
            };
        }

        return this._get(this._player, 'Metadata', this._metadata);
    }

    get MinimumRate() {
        return this._get(this._player, 'MinimumRate', 1.0);
    }

    get PlaybackStatus() {
        return this._get(this._player, 'PlaybackStatus', 'Stopped');
    }

    // g-properties-changed is not emitted for this property
    get Position() {
        try {
            const reply = this._player.call_sync(
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [
                    'org.mpris.MediaPlayer2.Player',
                    'Position',
                ]),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );

            return reply.recursiveUnpack()[0];
        } catch (e) {
            return 0;
        }
    }

    get Rate() {
        return this._get(this._player, 'Rate', 1.0);
    }

    set Rate(rate) {
        this._set(this._player, 'Rate', new GLib.Variant('d', rate));
    }

    get Shuffle() {
        return this._get(this._player, 'Shuffle', false);
    }

    set Shuffle(mode) {
        this._set(this._player, 'Shuffle', new GLib.Variant('b', mode));
    }

    get Volume() {
        return this._get(this._player, 'Volume', 1.0);
    }

    set Volume(level) {
        this._set(this._player, 'Volume', new GLib.Variant('d', level));
    }

    Next() {
        this._call(this._player, 'Next');
    }

    OpenUri(uri) {
        this._call(this._player, 'OpenUri', new GLib.Variant('(s)', [uri]));
    }

    Previous() {
        this._call(this._player, 'Previous');
    }

    Pause() {
        this._call(this._player, 'Pause');
    }

    Play() {
        this._call(this._player, 'Play');
    }

    PlayPause() {
        this._call(this._player, 'PlayPause');
    }

    Seek(offset) {
        this._call(this._player, 'Seek', new GLib.Variant('(x)', [offset]));
    }

    SetPosition(trackId, position) {
        this._call(this._player, 'SetPosition',
            new GLib.Variant('(ox)', [trackId, position]));
    }

    Stop() {
        this._call(this._player, 'Stop');
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();
        this._application.disconnect(this._applicationChangedId);
        this._player.disconnect(this._playerChangedId);
        this._player.disconnect(this._playerSignalId);
    }
});


/**
 * A manager for media players
 */
var Manager = GObject.registerClass({
    GTypeName: 'GSConnectMPRISManager',
    Signals: {
        'player-added': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-removed': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-changed': {
            param_types: [GObject.TYPE_OBJECT],
        },
        'player-seeked': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT64],
        },
    },
}, class Manager extends GObject.Object {

    _init() {
        super._init();

        // Asynchronous setup
        this._cancellable = new Gio.Cancellable();
        this._connection = Gio.DBus.session;
        this._players = new Map();
        this._paused = new Map();

        this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            this._onNameOwnerChanged.bind(this)
        );

        this._loadPlayers();
    }

    async _loadPlayers() {
        try {
            const names = await new Promise((resolve, reject) => {
                this._connection.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'ListNames',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    this._cancellable,
                    (connection, res) => {
                        try {
                            res = connection.call_finish(res);
                            resolve(res.deepUnpack()[0]);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            for (let i = 0, len = names.length; i < len; i++) {
                const name = names[i];

                if (!name.startsWith('org.mpris.MediaPlayer2'))
                    continue;

                if (!name.includes('GSConnect'))
                    this._addPlayer(name);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        }
    }

    _onNameOwnerChanged(connection, sender, object, iface, signal, parameters) {
        const [name, oldOwner, newOwner] = parameters.deepUnpack();

        if (name.includes('GSConnect'))
            return;

        if (newOwner.length)
            this._addPlayer(name);
        else if (oldOwner.length)
            this._removePlayer(name);
    }

    async _addPlayer(name) {
        try {
            if (!this._players.has(name)) {
                const player = new PlayerProxy(name);
                await player.initPromise();

                player.connect('notify',
                    (player) => this.emit('player-changed', player));

                player.connect('Seeked', this.emit.bind(this, 'player-seeked'));

                this._players.set(name, player);
                this.emit('player-added', player);
            }
        } catch (e) {
            debug(e, name);
        }
    }

    _removePlayer(name) {
        try {
            const player = this._players.get(name);

            if (player !== undefined) {
                this._paused.delete(name);
                this._players.delete(name);
                this.emit('player-removed', player);

                player.destroy();
            }
        } catch (e) {
            debug(e, name);
        }
    }

    /**
     * Check for a player by its Identity.
     *
     * @param {string} identity - A player name
     * @return {boolean} %true if the player was found
     */
    hasPlayer(identity) {
        for (const player of this._players.values()) {
            if (player.Identity === identity)
                return true;
        }

        return false;
    }

    /**
     * Get a player by its Identity.
     *
     * @param {string} identity - A player name
     * @return {GSConnectMPRISPlayer|null} A player or %null
     */
    getPlayer(identity) {
        for (const player of this._players.values()) {
            if (player.Identity === identity)
                return player;
        }

        return null;
    }

    /**
     * Get a list of player identities.
     *
     * @return {string[]} A list of player identities
     */
    getIdentities() {
        const identities = [];

        for (const player of this._players.values()) {
            const identity = player.Identity;

            if (identity)
                identities.push(identity);
        }

        return identities;
    }

    /**
     * A convenience function for pausing all players currently playing.
     */
    pauseAll() {
        for (const [name, player] of this._players) {
            if (player.PlaybackStatus === 'Playing' && player.CanPause) {
                player.Pause();
                this._paused.set(name, player);
            }
        }
    }

    /**
     * A convenience function for restarting all players paused with pauseAll().
     */
    unpauseAll() {
        for (const player of this._paused.values()) {
            if (player.PlaybackStatus === 'Paused' && player.CanPlay)
                player.Play();
        }

        this._paused.clear();
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        this._cancellable.cancel();
        this._connection.signal_unsubscribe(this._nameOwnerChangedId);

        this._paused.clear();
        this._players.forEach(player => player.destroy());
        this._players.clear();
    }
});


/**
 * The service class for this component
 */
var Component = Manager;

