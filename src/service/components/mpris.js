'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


var Player = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlayer',
    Implements: [Gio.DBusInterface],
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
        )
    },
    Signals: {
        'Seeked': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_INT64]
        }
    }
}, class Player extends Gio.DBusProxy {

    _init(name) {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2.Player'
        });

        this._application = new Gio.DBusProxy({
            g_bus_type: Gio.BusType.SESSION,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2'
        });

        this._propertiesChangedId = this._application.connect(
            'g-properties-changed',
            this._onPropertiesChanged.bind(this)
        );

        this._cancellable = new Gio.Cancellable();
    }

    vfunc_g_properties_changed(changed, invalidated) {
        try {
            if (this.__disposed !== undefined)
                return;

            for (let name in changed.deepUnpack()) {
                this.notify(name);
            }
        } catch (e) {
            logError(e, this.g_name);
        }
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        try {
            if (signal_name === 'Seeked') {
                this.emit('Seeked', parameters.deepUnpack()[0]);
            }
        } catch (e) {
            logError(e, this.g_name);
        }
    }

    _call(name, parameters = null) {
        this.call(
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
                    logError(e, this.g_name);
                }
            }
        );
    }

    _get(name, fallback = null) {
        try {
            return this.get_cached_property(name).recursiveUnpack();
        } catch (e) {
            return fallback;
        }
    }

    _set(name, value) {
        try {
            this.set_cached_property(name, value);

            this.call(
                'org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [this.g_interface_name, name, value]),
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                this._cancellable,
                (proxy, result) => {
                    try {
                        proxy.call_finish(result);
                    } catch (e) {
                        logError(e);
                    }
                }
            );
        } catch (e) {
            logError(e, this.g_name);
        }
    }

    _onPropertiesChanged(proxy, changed, invalidated) {
        try {
            if (this.__disposed !== undefined)
                return;

            for (let name in changed.deepUnpack()) {
                this.notify(name);
            }
        } catch (e) {
            logError(e, this.g_name);
        }
    }

    initPromise() {
        let player = new Promise((resolve, reject) => {
            this.init_async(0, this._cancellable, (proxy, res) => {
                try {
                    resolve(proxy.init_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        let application = new Promise((resolve, reject) => {
            this._application.init_async(0, this._cancellable, (proxy, res) => {
                try {
                    resolve(proxy.init_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        return Promise.all([player, application]);
    }

    /*
     * The org.mpris.MediaPlayer2 Interface
     */
    get CanQuit() {
        return this._get.call(this._application, 'CanQuit', false);
    }

    get Fullscreen() {
        return this._get.call(this._application, 'Fullscreen', false);
    }

    set Fullscreen(mode) {
        this._set.call(this._application, 'Fullscreen', new GLib.Variant('b', mode));
    }

    get CanSetFullscreen() {
        return this._get.call(this._application, 'CanSetFullscreen', false);
    }

    get CanRaise() {
        return this._get.call(this._application, 'CanRaise', false);
    }

    get HasTrackList() {
        return this._get.call(this._application, 'HasTrackList', false);
    }

    get Identity() {
        return this._get.call(this._application, 'Identity', _('Unknown'));
    }

    get DesktopEntry() {
        return this._get.call(this._application, 'DesktopEntry', null);
    }

    get SupportedUriSchemes() {
        return this._get.call(this._application, 'SupportedUriSchemes', []);
    }

    get SupportedMimeTypes() {
        return this._get.call(this._application, 'SupportedMimeTypes', []);
    }

    Raise() {
        this._call.call(this._application, 'Raise');
    }

    Quit() {
        this._call.call(this._application, 'Quit');
    }

    /*
     * The org.mpris.MediaPlayer2.Player Interface
     */
    get PlaybackStatus() {
        return this._get('PlaybackStatus', 'Stopped');
    }

    // 'None', 'Track', 'Playlist'
    get LoopStatus() {
        return this._get('LoopStatus', 'None');
    }

    set LoopStatus(status) {
        this._set('LoopStatus', new GLib.Variant('s', status));
    }

    get Rate() {
        return this._get('Rate', 1.0);
    }

    set Rate(rate) {
        this._set('Rate', new GLib.Variant('d', rate));
    }

    get Shuffle() {
        return this._get('Shuffle', false);
    }

    set Shuffle(mode) {
        this._set('Shuffle', new GLib.Variant('b', mode));
    }

    get Metadata() {
        if (this._metadata == undefined) {
            this._metadata = {
                'xesam:artist': [_('Unknown')],
                'xesam:album': _('Unknown'),
                'xesam:title': _('Unknown'),
                'mpris:length': 0
            };
        }

        return this._get('Metadata', this._metadata);
    }

    get Volume() {
        return this._get('Volume', 1.0);
    }

    set Volume(level) {
        this._set('Volume', new GLib.Variant('d', level));
    }

    // g-properties-changed is not emitted for this property
    get Position() {
        try {
            let reply = this.call_sync(
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [this.g_interface_name, 'Position']),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );

            return reply.recursiveUnpack()[0];
        } catch (e) {
            logError(e, this.g_name);
            return 0;
        }
    }

    get MinimumRate() {
        return this._get('MinimumRate', 1.0);
    }

    get MaximumRate() {
        return this._get('MaximumRate', 1.0);
    }

    get CanGoNext() {
        return this._get('CanGoNext', false);
    }

    get CanGoPrevious() {
        return this._get('CanGoPrevious', false);
    }

    get CanPlay() {
        return this._get('CanPlay', false);
    }

    get CanPause() {
        return this._get('CanPause', false);
    }

    get CanSeek() {
        return this._get('CanSeek', false);
    }

    get CanControl() {
        return this._get('CanControl', false);
    }

    Next() {
        this._call('Next');
    }

    Previous() {
        this._call('Previous');
    }

    Pause() {
        this._call('Pause');
    }

    PlayPause() {
        this._call('PlayPause');
    }

    Stop() {
        this._call('Stop');
    }

    Play() {
        this._call('Play');
    }

    Seek(offset) {
        this._call('Seek', new GLib.Variant('(x)', [offset]));
    }

    SetPosition(trackId, position) {
        this._call('SetPosition', new GLib.Variant('(ox)', [trackId, position]));
    }

    OpenUri(uri) {
        this._call('OpenUri', new GLib.Variant('(s)', [uri]));
    }

    destroy() {
        if (this.__disposed === undefined) {
            this.__disposed = true;

            this._cancellable.cancel();

            this._application.disconnect(this._propertiesChangedId);
            this._application.run_dispose();

            this.run_dispose();
        }
    }
});


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

                if (name.startsWith('org.mpris.MediaPlayer2') &&
                    !name.includes('GSConnect')) {
                    this._addPlayer(name);
                }
            }
        } catch (e) {
            // FIXME: if something goes wrong the component will appear active
            logError(e);
            this.destroy();
        }
    }

    get identities() {
        let identities = [];

        for (let player of this.players.values()) {
            let identity = player.Identity;

            if (identity)
                identities.push(identity);
        }

        return identities;
    }

    get players() {
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

                if (name.startsWith('org.mpris.MediaPlayer2') &&
                    !name.includes('GSConnect')) {
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
            let player = new Player(name);
            await player.initPromise();

            player._propertiesId = player.connect(
                'g-properties-changed',
                (player) => this.emit('player-changed', player)
            );

            player._seekedId = player.connect(
                'Seeked',
                (player) => this.emit('player-seeked', player)
            );

            this.players.set(name, player);
            this.notify('players');
        } catch (e) {
            debug(e);
        }
    }

    async _removePlayer(name) {
        try {
            let player = this.players.get(name);

            if (player !== undefined) {
                debug(`Removing MPRIS Player ${name}`);

                player.disconnect(player._propertiesId);
                player.disconnect(player._seekedId);
                player.destroy();

                this.paused.delete(name);
                this.players.delete(name);
                this.notify('players');
            }
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Get a player by its Identity.
     */
    getPlayer(identity) {
        for (let player of this.players.values()) {
            if (player.Identity === identity) {
                return player;
            }
        }

        return null;
    }

    /**
     * A convenience function for pausing all players currently playing.
     */
    pauseAll() {
        for (let [name, player] of this.players.entries()) {
            if (player.PlaybackStatus === 'Playing' && player.CanPause) {
                player.Pause();
                this.paused.set(name, player);
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
        if (this.__disposed == undefined) {
            this.__disposed = true;

            for (let player of this.players.values()) {
                player.disconnect(player._propertiesId);
                player.disconnect(player._seekedId);
                player.destroy();
            }

            this.players.clear();

            this.run_dispose();
        }
    }
});


/**
 * The service class for this component
 */
var Component = Manager;

