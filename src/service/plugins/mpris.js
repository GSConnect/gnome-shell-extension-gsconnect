'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const Config = imports.config;
const DBus = imports.utils.dbus;
const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('MPRIS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.MPRIS',
    incomingCapabilities: ['kdeconnect.mpris', 'kdeconnect.mpris.request'],
    outgoingCapabilities: ['kdeconnect.mpris', 'kdeconnect.mpris.request'],
    actions: {},
};


/**
 * MPRIS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mpriscontrol
 *
 * See also:
 *     https://specifications.freedesktop.org/mpris-spec/latest/
 *     https://github.com/GNOME/gnome-shell/blob/master/js/ui/mpris.js
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlugin',
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'mpris');

        this._players = new Map();
        this._transferring = new WeakSet();
        this._updating = new WeakSet();

        this._mpris = Components.acquire('mpris');

        this._playerAddedId = this._mpris.connect(
            'player-added',
            this._sendPlayerList.bind(this)
        );

        this._playerRemovedId = this._mpris.connect(
            'player-removed',
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
    }

    connected() {
        super.connected();

        this._requestPlayerList();
        this._sendPlayerList();
    }

    disconnected() {
        super.disconnected();

        for (let [identity, player] of this._players) {
            this._players.delete(identity);
            player.destroy();
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.mpris':
                this._handleStatus(packet);
                break;

            case 'kdeconnect.mpris.request':
                this._handleRequest(packet);
                break;
        }
    }

    /**
     * Handle a remote player update.
     *
     * @param {Core.Packet} packet - A `kdeconnect.mpris`
     */
    _handleStatus(packet) {
        try {
            if (packet.body.hasOwnProperty('playerList'))
                this._handlePlayerList(packet.body.playerList);
            else if (packet.body.hasOwnProperty('player'))
                this._handlePlayerState(packet.body);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Handle an updated list of remote players.
     *
     * @param {string[]} playerList - A list of remote player names
     */
    _handlePlayerList(playerList) {
        // Destroy removed players before adding new ones
        for (let player of this._players.values()) {
            if (!playerList.includes(player.Identity)) {
                this._players.delete(player.Identity);
                player.destroy();
            }
        }

        for (let identity of playerList) {
            if (!this._players.has(identity)) {
                let player = new RemotePlayer(this.device, identity);
                this._players.set(identity, player);
            }

            // Always request player updates; packets are cheap
            this.device.sendPacket({
                type: 'kdeconnect.mpris.request',
                body: {
                    player: identity,
                    requestNowPlaying: true,
                    requestVolume: true,
                },
            });
        }
    }

    /**
     * Handle an update for a remote player.
     *
     * @param {Object} state - The body of a `kdeconnect.mpris` packet
     */
    _handlePlayerState(state) {
        let player = this._players.get(state.player);

        if (player !== undefined)
            player.update(state);
    }

    /**
     * Request a list of remote players.
     */
    _requestPlayerList() {
        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                requestPlayerList: true,
            },
        });
    }

    /**
     * Handle a request for player information or action.
     *
     * @param {Core.Packet} packet - a `kdeconnect.mpris.request`
     * @return {undefined} no return value
     */
    _handleRequest(packet) {
        // A request for the list of players
        if (packet.body.hasOwnProperty('requestPlayerList'))
            return this._sendPlayerList();

        // A request for an unknown player; send the list of players
        if (!this._mpris.hasPlayer(packet.body.player))
            return this._sendPlayerList();

        // An album art request
        if (packet.body.hasOwnProperty('albumArtUrl'))
            return this._sendAlbumArt(packet);

        // A player command
        this._handleCommand(packet);
    }

    /**
     * Handle an incoming player command or information request
     *
     * @param {Core.Packet} packet - A `kdeconnect.mpris.request`
     */
    async _handleCommand(packet) {
        if (!this.settings.get_boolean('share-players'))
            return;

        let player;

        try {
            player = this._mpris.getPlayer(packet.body.player);

            if (player === undefined || this._updating.has(player))
                return;

            this._updating.add(player);

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
                        debug(`unknown action: ${packet.body.action}`);
                }
            }

            // Player Properties
            if (packet.body.hasOwnProperty('setVolume'))
                player.Volume = packet.body.setVolume / 100;

            if (packet.body.hasOwnProperty('Seek'))
                await player.Seek(packet.body.Seek);

            if (packet.body.hasOwnProperty('SetPosition')) {
                let offset = (packet.body.SetPosition * 1000) - player.Position;
                await player.Seek(offset);
            }

            // Information Request
            let hasResponse = false;

            let response = {
                type: 'kdeconnect.mpris',
                body: {
                    player: packet.body.player,
                },
            };

            if (packet.body.hasOwnProperty('requestNowPlaying')) {
                hasResponse = true;

                Object.assign(response.body, {
                    pos: Math.floor(player.Position / 1000),
                    isPlaying: (player.PlaybackStatus === 'Playing'),
                    canPause: player.CanPause,
                    canPlay: player.CanPlay,
                    canGoNext: player.CanGoNext,
                    canGoPrevious: player.CanGoPrevious,
                    canSeek: player.CanSeek,
                    artist: _('Unknown'),
                    title: _('Unknown'),
                });

                let metadata = player.Metadata;

                if (metadata.hasOwnProperty('mpris:artUrl')) {
                    let file = Gio.File.new_for_uri(metadata['mpris:artUrl']);
                    response.body.albumArtUrl = file.get_uri();
                }

                if (metadata.hasOwnProperty('mpris:length')) {
                    let trackLen = Math.floor(metadata['mpris:length'] / 1000);
                    response.body.length = trackLen;
                }

                if (metadata.hasOwnProperty('xesam:artist')) {
                    let artists = metadata['xesam:artist'];
                    response.body.artist = artists.join(', ');
                }

                if (metadata.hasOwnProperty('xesam:title'))
                    response.body.title = metadata['xesam:title'];

                if (metadata.hasOwnProperty('xesam:album'))
                    response.body.album = metadata['xesam:album'];

                response.body.nowPlaying = [
                    response.body.artist,
                    response.body.title,
                ].join(' - ');
            }

            if (packet.body.hasOwnProperty('requestVolume')) {
                hasResponse = true;
                response.body.volume = player.Volume * 100;
            }

            if (hasResponse)
                this.device.sendPacket(response);
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this._updating.delete(player);
        }
    }

    _onPlayerChanged(mpris, player) {
        if (!this.settings.get_boolean('share-players'))
            return;

        this._handleCommand({
            body: {
                player: player.Identity,
                requestNowPlaying: true,
                requestVolume: true,
            },
        });
    }

    _onPlayerSeeked(mpris, player) {
        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                player: player.Identity,
                pos: Math.floor(player.Position / 1000),
            },
        });
    }

    async _sendAlbumArt(packet) {
        let player;

        try {
            // Reject concurrent requests for album art
            player = this._mpris.getPlayer(packet.body.player);

            if (player === undefined || this._transferring.has(player))
                return;

            // Ensure the requested albumArtUrl matches the current mpris:artUrl
            let metadata = player.Metadata;

            if (!metadata.hasOwnProperty('mpris:artUrl'))
                return;

            let file = Gio.File.new_for_uri(metadata['mpris:artUrl']);
            let request = Gio.File.new_for_uri(packet.body.albumArtUrl);

            if (file.get_uri() !== request.get_uri())
                throw RangeError(`invalid URI "${packet.body.albumArtUrl}"`);

            // Transfer the album art
            this._transferring.add(player);

            let transfer = this.device.createTransfer();

            transfer.addFile({
                type: 'kdeconnect.mpris',
                body: {
                    transferringAlbumArt: true,
                    player: packet.body.player,
                    albumArtUrl: packet.body.albumArtUrl,
                },
            }, file);

            await transfer.start();
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this._transferring.delete(player);
        }
    }

    /**
     * Send the list of player identities and indicate whether we support
     * transferring album art
     */
    _sendPlayerList() {
        let playerList = [];

        if (this.settings.get_boolean('share-players'))
            playerList = this._mpris.getIdentities();

        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                playerList: playerList,
                supportAlbumArtPayload: true,
            },
        });
    }

    destroy() {
        if (this._mpris !== undefined) {
            this._mpris.disconnect(this._playerAddedId);
            this._mpris.disconnect(this._playerRemovedId);
            this._mpris.disconnect(this._playerChangedId);
            this._mpris.disconnect(this._playerSeekedId);
            this._mpris = Components.release('mpris');
        }

        for (let [identity, player] of this._players) {
            this._players.delete(identity);
            player.destroy();
        }

        super.destroy();
    }
});


/*
 * A class for mirroring a remote Media Player on DBus
 */
const MPRISIface = Config.DBUS.lookup_interface('org.mpris.MediaPlayer2');
const MPRISPlayerIface = Config.DBUS.lookup_interface('org.mpris.MediaPlayer2.Player');


const RemotePlayer = GObject.registerClass({
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
        ),
    },
    Signals: {
        'Seeked': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_INT64],
        },
    },
}, class RemotePlayer extends GObject.Object {

    _init(device, identity) {
        super._init();

        this._device = device;
        this._Identity = identity;
        this._isPlaying = false;

        this._ownerId = 0;
        this._connection = null;
        this._applicationIface = null;
        this._playerIface = null;
    }

    async export() {
        try {
            if (this._connection === null) {
                this._connection = await DBus.newConnection();

                if (this._applicationIface === null) {
                    this._applicationIface = new DBus.Interface({
                        g_instance: this,
                        g_connection: this._connection,
                        g_object_path: '/org/mpris/MediaPlayer2',
                        g_interface_info: MPRISIface,
                    });
                }

                if (this._playerIface === null) {
                    this._playerIface = new DBus.Interface({
                        g_instance: this,
                        g_connection: this._connection,
                        g_object_path: '/org/mpris/MediaPlayer2',
                        g_interface_info: MPRISPlayerIface,
                    });
                }
            }

            if (this._ownerId !== 0)
                return;

            let name = [
                this.device.name,
                this.Identity,
            ].join('').replace(/[\W]*/g, '');

            this._ownerId = Gio.bus_own_name_on_connection(
                this._connection,
                `org.mpris.MediaPlayer2.GSConnect.${name}`,
                Gio.BusNameOwnerFlags.NONE,
                null,
                null
            );
        } catch (e) {
            debug(e, this.Identity);
        }
    }

    unexport() {
        if (this._ownerId === 0)
            return;

        Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
    }

    update(state) {
        this.freeze_notify();

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

        if (metadataChanged)
            this.notify('Metadata');

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

        if (state.hasOwnProperty('pos'))
            this._Position = state.pos * 1000;

        if (state.hasOwnProperty('volume')) {
            if (this.Volume !== state.volume / 100) {
                this._Volume = state.volume / 100;
                this.notify('Volume');
            }
        }

        this.thaw_notify();

        if (!this._isPlaying && !this.CanControl)
            this.unexport();
        else
            this.export();
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
        if (this._isPlaying)
            return 'Playing';

        return 'Stopped';
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
        if (this._metadata === undefined)
            this._metadata = {};

        Object.assign(this._metadata, {
            'xesam:artist': new GLib.Variant('as', [this._artist || '']),
            'xesam:album': new GLib.Variant('s', this._album || ''),
            'xesam:title': new GLib.Variant('s', this._title || ''),
            'mpris:length': new GLib.Variant('x', this._length || 0),
        });

        return this._metadata;
    }

    get Volume() {
        if (this._Volume === undefined)
            this._Volume = 1.0;

        return this._Volume;
    }

    set Volume(level) {
        if (this._Volume === level)
            return;

        this._Volume = level;
        this.notify('Volume');

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                setVolume: Math.floor(this.Volume * 100),
            },
        });
    }

    get Position() {
        if (this._Position === undefined)
            this._Position = 0;

        return this._Position;
    }

    get MinimumRate() {
        return 1.0;
    }

    get MaximumRate() {
        return 1.0;
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

    get CanPlay() {
        if (this._CanPlay === undefined)
            this._CanPlay = false;

        return this._CanPlay;
    }

    get CanPause() {
        if (this._CanPause === undefined)
            this._CanPause = false;

        return this._CanPause;
    }

    get CanSeek() {
        if (this._CanSeek === undefined)
            this._CanSeek = false;

        return this._CanSeek;
    }

    get CanControl() {
        if (this._CanControl === undefined)
            this._CanControl = false;

        return (this.CanPlay || this.CanPause);
    }

    Next() {
        if (!this.CanControl || !this.CanGoNext)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Next',
            },
        });
    }

    Previous() {
        if (!this.CanControl || !this.CanGoPrevious)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Previous',
            },
        });
    }

    Pause() {
        if (!this.CanControl || !this.CanPause)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Pause',
            },
        });
    }

    PlayPause() {
        if (!this.CanPlay && !this.CanPause)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'PlayPause',
            },
        });
    }

    Stop() {
        if (!this.CanControl)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Stop',
            },
        });
    }

    Play() {
        if (!this.CanControl || !this.CanPlay)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Next',
            },
        });
    }

    Seek(offset) {
        if (!this.CanControl || !this.CanSeek)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                Seek: offset,
            },
        });
    }

    SetPosition(trackId, position) {
        debug(`${this._Identity}: SetPosition(${trackId}, ${position})`);

        if (!this.CanControl || !this.CanSeek)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                SetPosition: position / 1000,
            },
        });
    }

    OpenUri(uri) {
        debug(`OpenUri(${uri}): Not Supported`);
    }

    destroy() {
        this.unexport();

        if (this._connection) {
            this._connection.close(null, null);
            this._connection = null;

            if (this._applicationIface) {
                this._applicationIface.destroy();
                this._applicationIface = null;
            }

            if (this._playerIface) {
                this._playerIface.destroy();
                this._playerIface = null;
            }
        }
    }
});

