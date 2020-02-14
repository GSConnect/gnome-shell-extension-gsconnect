'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const DBus = imports.service.components.dbus;


var Metadata = {
    label: _('MPRIS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.MPRIS',
    incomingCapabilities: ['kdeconnect.mpris', 'kdeconnect.mpris.request'],
    outgoingCapabilities: ['kdeconnect.mpris', 'kdeconnect.mpris.request'],
    actions: {}
};


/**
 * MPRIS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mpriscontrol
 *
 * See also:
 *     https://specifications.freedesktop.org/mpris-spec/latest/
 *     https://github.com/GNOME/gnome-shell/blob/master/js/ui/mpris.js
 *     https://github.com/JasonLG1979/gnome-shell-extensions-mediaplayer/wiki/Known-Player-Bugs
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'mpris');

        try {
            this._mpris = this.service.components.get('mpris');

            this._notifyPlayersId = this._mpris.connect(
                'notify::players',
                this._sendPlayerList.bind(this)
            );

            this._playerChangedId = this._mpris.connect(
                'player-changed',
                this._onPlayerChanged.bind(this)
            );

            this._playerSeekedId = this._mpris.connect(
                'player-seeked',
                this._onPlayerSeeked.bind(this)
            );
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    get players() {
        if (this._players === undefined) {
            this._players = new Map();
        }

        return this._players;
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.mpris.request') {
            this._handleRequest(packet);
        } else if (packet.type === 'kdeconnect.mpris') {
            this._handleStatus(packet);
        }
    }

    connected() {
        super.connected();

        this._requestPlayerList();
        this._sendPlayerList();
    }

    _handleStatus(packet) {
        try {
            if (packet.body.hasOwnProperty('playerList')) {
                this._handlePlayerList(packet.body.playerList);
            } else if (packet.body.hasOwnProperty('player')) {
                this._handlePlayerState(packet.body);
            }
        } catch (e) {
            debug(e, `${this.device.name}: MPRIS`);
        }
    }

    /**
     * Handle a player list update
     *
     * @param {array} playerList - A list of remote player names
     */
    _handlePlayerList(playerList) {
        for (let player of this.players.values()) {
            if (!playerList.includes(player.Identity)) {
                this.players.delete(player.Identity);
                player.destroy();
            }
        }

        for (let identity of playerList) {
            this._device.sendPacket({
                type: 'kdeconnect.mpris.request',
                body: {
                    player: identity,
                    requestNowPlaying: true,
                    requestVolume: true
                }
            });
        }
    }

    /**
     * Handle a player state update
     *
     * @param {object} state - The body of a kdeconnect.mpris packet
     */
    _handlePlayerState(state) {
        let player = this.players.get(state.player);

        if (player === undefined) {
            player = new RemotePlayer(this.device, state);
            this.players.set(state.player, player);
        } else {
            player.parseState(state);
        }
    }

    /**
     * Request the list of player identities
     */
    _requestPlayerList() {
        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                requestPlayerList: true
            }
        });
    }

    _handleRequest(packet) {
        // A request for the list of players
        if (packet.body.requestPlayerList) {
            this._sendPlayerList();

        // A request for an unknown player; send the list of players
        } else if (!this._mpris.players.has(packet.body.player)) {
            this._sendPlayerList();

        // An album art request
        } else if (packet.body.hasOwnProperty('albumArtUrl')) {
            this._sendAlbumArt(packet);

        // A player command
        } else {
            this._handleCommand(packet);
        }
    }

    /**
     * Handle an incoming player command or information request
     *
     * @param {kdeconnect.mpris.request} - A command for a specific player
     */
    async _handleCommand(packet) {
        if (this._updating || !this.settings.get_boolean('share-players')) {
            return;
        }

        try {
            this._updating = true;

            let player = this._mpris.players.get(packet.body.player);

            // Player Actions
            if (packet.body.hasOwnProperty('action')) {
                switch (packet.body.action) {
                    case 'PlayPause':
                    case 'Play':
                    case 'Pause':
                    case 'Next':
                    case 'Previous':
                    case 'Stop':
                        player[packet.body.action]();
                        break;

                    default:
                        logError(new Error(`unknown action: ${packet.body.action}`));
                }
            }

            // Player Properties
            if (packet.body.hasOwnProperty('setVolume')) {
                player.Volume = packet.body.setVolume / 100;
            }

            if (packet.body.hasOwnProperty('Seek')) {
                await player.Seek(packet.body.Seek);
            }

            if (packet.body.hasOwnProperty('SetPosition')) {
                let offset = (packet.body.SetPosition * 1000) - player.Position;
                await player.Seek(offset);
            }

            // Information Request
            let hasResponse = false;

            let response = {
                type: 'kdeconnect.mpris',
                body: {}
            };

            if (packet.body.hasOwnProperty('requestNowPlaying')) {
                hasResponse = true;

                response.body = {
                    pos: Math.floor(player.Position / 1000),
                    isPlaying: (player.PlaybackStatus === 'Playing'),
                    canPause: player.CanPause,
                    canPlay: player.CanPlay,
                    canGoNext: player.CanGoNext,
                    canGoPrevious: player.CanGoPrevious,
                    canSeek: player.CanSeek
                };

                Object.assign(response.body, this._getPlayerMetadata(player));
            }

            if (packet.body.hasOwnProperty('requestVolume')) {
                hasResponse = true;
                response.body.volume = player.Volume * 100;
            }

            if (hasResponse) {
                response.body.player = packet.body.player;
                this.device.sendPacket(response);
            }
        } catch (e) {
            logError(e);
        } finally {
            this._updating = false;
        }
    }

    /**
     * Get the track metadata for a player
     *
     * @param {Gio.DBusProxy} player - The player to get track info for
     * @return {Object} - An object of track data in MPRIS packet body format
     */
    _getPlayerMetadata(player) {
        let metadata = {};

        try {
            if (player.Metadata !== null) {
                let nowPlaying = player.Metadata['xesam:title'];

                if (player.Metadata.hasOwnProperty('xesam:artist')) {
                    nowPlaying = `${player.Metadata['xesam:artist']} - ${nowPlaying}`;
                }

                metadata.nowPlaying = nowPlaying;

                if (player.Metadata.hasOwnProperty('mpris:artUrl')) {
                    metadata.albumArtUrl = player.Metadata['mpris:artUrl'];
                }

                if (player.Metadata.hasOwnProperty('mpris:length')) {
                    metadata.length = Math.floor(player.Metadata['mpris:length'] / 1000);
                }
            }
        } catch (e) {
            logError(e);
        }

        return metadata;
    }

    _onPlayerChanged(mpris, player) {
        if (!this.settings.get_boolean('share-players')) {
            return;
        }

        this._handleCommand({
            body: {
                player: player.Identity,
                requestNowPlaying: true,
                requestVolume: true
            }
        });
    }

    _onPlayerSeeked(mpris, player) {
        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                player: player.Identity,
                pos: Math.floor(player.Position / 1000)
            }
        });
    }

    async _sendAlbumArt(packet) {
        try {
            // Reject concurrent requests for album art
            if (this._transferring) {
                return;
            }

            let player = this._mpris.players.get(packet.body.player);

            if (player.Metadata === null) {
                return;
            }

            // Ensure the requested albumArtUrl matches the current mpris:artUrl
            if (packet.body.albumArtUrl !== player.Metadata['mpris:artUrl']) {
                return;
            }

            // Start the transfer process
            this._transferring = true;

            let file = Gio.File.new_for_uri(packet.body.albumArtUrl);

            let transfer = this.device.createTransfer({
                input_stream: file.read(null),
                size: file.query_info('standard::size', 0, null).get_size()
            });

            await transfer.upload({
                type: 'kdeconnect.mpris',
                body: {
                    transferringAlbumArt: true,
                    player: packet.body.player,
                    albumArtUrl: packet.body.albumArtUrl
                }
            });
        } catch (e) {
            debug(e, 'transferring album art');
        } finally {
            this._transferring = false;
        }
    }

    /**
     * Send the list of player identities and indicate whether we support
     * transferring album art
     */
    _sendPlayerList() {
        let playerList = [];

        if (this.settings.get_boolean('share-players')) {
            playerList = this._mpris.identities;
        }

        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                playerList: playerList,
                supportAlbumArtPayload: true
            }
        });
    }

    destroy() {
        try {
            this._mpris.disconnect(this._notifyPlayersId);
            this._mpris.disconnect(this._playerChangedId);
            this._mpris.disconnect(this._playerSeekedId);
        } catch (e) {
            // Silence errors
        }

        for (let [identity, player] of this.players.entries()) {
            player.destroy();
            this.players.delete(identity);
        }

        super.destroy();
    }
});


/*
 * A class for mirroring a remote Media Player on DBus
 */
const MPRISIface = gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2');
const MPRISPlayerIface = gsconnect.dbusinfo.lookup_interface('org.mpris.MediaPlayer2.Player');


var RemotePlayer = GObject.registerClass({
    GTypeName: 'GSConnectMPRISRemotePlayer',
    Properties: {
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
}, class RemotePlayer extends GObject.Object {

    _init(device, initialState) {
        super._init();

        this._device = device;
        this._isPlaying = false;

        this._ownerId = 0;
        this._applicationIface = null;
        this._playerIface = null;

        this.parseState(initialState);
    }

    _onNameAcquired(connection, name) {
        debug(name);

        if (!this._applicationIface) {
            this._applicationIface = new DBus.Interface({
                g_instance: this,
                g_connection: connection,
                g_object_path: '/org/mpris/MediaPlayer2',
                g_interface_info: MPRISIface
            });
        }

        if (!this._playerIface) {
            this._playerIface = new DBus.Interface({
                g_instance: this,
                g_connection: connection,
                g_object_path: '/org/mpris/MediaPlayer2',
                g_interface_info: MPRISPlayerIface
            });
        }
    }

    _onNameLost(connection, name) {
        debug(name);

        if (this._applicationIface) {
            this._applicationIface.destroy();
            this._applicationIface = null;
        }

        if (this._playerIface) {
            this._playerIface.destroy();
            this._playerIface = null;
        }
    }

    async export() {
        try {
            if (this._ownerId === 0) {
                let name = [
                    this.device.name,
                    this.Identity
                ].join('').replace(/[\W]*/g, '');

                let connection = await DBus.newConnection();

                this._ownerId = Gio.bus_own_name_on_connection(
                    connection,
                    `org.mpris.MediaPlayer2.GSConnect.${name}`,
                    Gio.BusNameOwnerFlags.NONE,
                    this._onNameAcquired.bind(this),
                    this._onNameLost.bind(this)
                );
            }
        } catch (e) {
            logError(e);
        }
    }

    unexport() {
        if (this._ownerId !== 0) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }

        if (this._applicationIface) {
            this._applicationIface.destroy();
            this._applicationIface = null;
        }

        if (this._playerIface) {
            this._playerIface.destroy();
            this._playerIface = null;
        }
    }

    parseState(state) {
        this._Identity = state.player;

        // Metadata
        let metadataChanged = false;

        if (state.hasOwnProperty('title')) {
            metadataChanged = true;
            this._title = state.title;
        }

        if (state.hasOwnProperty('artist')) {
            metadataChanged = true;
            this._artist = state.artist;
        }

        if (state.hasOwnProperty('album')) {
            metadataChanged = true;
            this._album = state.album;
        }

        if (state.hasOwnProperty('length')) {
            metadataChanged = true;
            this._length = state.length * 1000;
        }

        // Probably a good idea to update this before emitting the length change
        if (state.hasOwnProperty('pos')) {
            this._Position = state.pos * 1000;
        }

        if (metadataChanged) this.notify('Metadata');

        // Playback Status
        if (state.hasOwnProperty('isPlaying')) {
            if (this._isPlaying !== state.isPlaying) {
                this._isPlaying = state.isPlaying;
                this.notify('PlaybackStatus');
            }
        }

        if (state.hasOwnProperty('canPlay')) {
            if (this.CanPlay !== state.canPlay) {
                this._CanPlay = state.canPlay;
                this.notify('CanPlay');
            }
        }

        if (state.hasOwnProperty('canPause')) {
            if (this.CanPause !== state.canPause) {
                this._CanPause = state.canPause;
                this.notify('CanPause');
            }
        }

        if (state.hasOwnProperty('canGoNext')) {
            if (this.CanGoNext !== state.canGoNext) {
                this._CanGoNext = state.canGoNext;
                this.notify('CanGoNext');
            }
        }

        if (state.hasOwnProperty('canGoPrevious')) {
            if (this.CanGoPrevious !== state.canGoPrevious) {
                this._CanGoPrevious = state.canGoPrevious;
                this.notify('CanGoPrevious');
            }
        }

        if (state.hasOwnProperty('volume')) {
            this.volume = state.volume / 100;
        }

        if (!this._isPlaying && !this.CanControl) {
            this.unexport();
        } else {
            this.export();
        }
    }

    /*
     * Native properties
     */
    get device() {
        return this._device;
    }

    /*
     * The org.mpris.MediaPlayer2 Interface
     */
    get CanQuit() {
        return false;
    }

    get Fullscreen() {
        return false;
    }

    get CanSetFullscreen() {
        return false;
    }

    get CanRaise() {
        return false;
    }

    get HasTrackList() {
        return false;
    }

    get Identity() {
        return this._Identity;
    }

    get DesktopEntry() {
        return 'org.gnome.Shell.Extensions.GSConnect';
    }

    get SupportedUriSchemes() {
        return [];
    }

    get SupportedMimeTypes() {
        return [];
    }

    Raise() {
    }

    Quit() {
    }

    /*
     * The org.mpris.MediaPlayer2.Player Interface
     */

    // 'Playing', 'Paused', 'Stopped'
    get PlaybackStatus() {
        if (this._isPlaying) {
            return 'Playing';
        } else {
            return 'Stopped';
        }
    }

    // 'None', 'Track', 'Playlist'
    get LoopStatus() {
        return 'None';
    }

    set LoopStatus(status) {
        this.notify('LoopStatus');
    }

    get Rate() {
        return 1.0;
    }

    set Rate(rate) {
        this.notify('Rate');
    }

    get Shuffle() {
        return false;
    }

    set Shuffle(mode) {
        this.notify('Shuffle');
    }

    get Metadata() {
        if (this._metadata === undefined) {
            this._metadata = {};
        }

        Object.assign(this._metadata, {
            'xesam:artist': new GLib.Variant('as', [this._artist || '']),
            'xesam:album': new GLib.Variant('s', this._album || ''),
            'xesam:title': new GLib.Variant('s', this._title || ''),
            'mpris:length': new GLib.Variant('x', this._length || 0)
        });

        return this._metadata;
    }

    get Volume() {
        if (this._Volume === undefined) {
            this._Volume = 1.0;
        }

        return this._Volume;
    }

    set Volume(level) {
        if (this._Volume !== level) {
            this._Volume = level;
            this.notify('Volume');

            this.device.sendPacket({
                type: 'kdeconnect.mpris.request',
                body: {
                    player: this.Identity,
                    setVolume: this.Volume * 100
                }
            });
        }
    }

    get Position() {
        if (this._Position === undefined) {
            this._Position = 0;
        }

        return this._Position;
    }

    get MinimumRate() {
        return 1.0;
    }

    get MaximumRate() {
        return 1.0;
    }

    get CanGoNext() {
        if (this._CanGoNext === undefined) {
            this._CanGoNext = false;
        }

        return this._CanGoNext;
    }

    get CanGoPrevious() {
        if (this._CanGoPrevious === undefined) {
            this._CanGoPrevious = false;
        }

        return this._CanGoPrevious;
    }

    get CanPlay() {
        if (this._CanPlay === undefined) {
            this._CanPlay = false;
        }

        return this._CanPlay;
    }

    get CanPause() {
        if (this._CanPause === undefined) {
            this._CanPause = false;
        }

        return this._CanPause;
    }

    get CanSeek() {
        if (this._CanSeek === undefined) {
            this._CanSeek = false;
        }

        return this._CanSeek;
    }

    get CanControl() {
        if (this._CanControl === undefined) {
            this._CanControl = false;
        }

        return (this.CanPlay || this.CanPause);
    }

    Next() {
        if (!this.CanControl || !this.CanGoNext) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Next'
            }
        });
    }

    Previous() {
        if (!this.CanControl || !this.CanGoPrevious) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Previous'
            }
        });
    }

    Pause() {
        if (!this.CanControl || !this.CanGoPause) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Pause'
            }
        });
    }

    PlayPause() {
        if (!this.CanControl || !this.CanPause) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'PlayPause'
            }
        });
    }

    Stop() {
        if (!this.CanControl) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Stop'
            }
        });
    }

    Play() {
        if (!this.CanControl || !this.CanPlay) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Next'
            }
        });
    }

    Seek(offset) {
        if (!this.CanControl || !this.CanSeek) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                Seek: offset
            }
        });
    }

    SetPosition(trackId, position) {
        debug(`${this._Identity}: SetPosition(${trackId}, ${position})`);

        if (!this.CanControl || !this.CanSeek) return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                SetPosition: position / 1000
            }
        });
    }

    OpenUri(uri) {
        debug(`OpenUri(${uri}): Not Supported`);
    }

    destroy() {
        this.unexport();
    }
});

