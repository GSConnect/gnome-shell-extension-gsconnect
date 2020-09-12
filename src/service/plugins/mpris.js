'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Components = imports.service.components;
const Config = imports.config;
const DBus = imports.service.utils.dbus;
const MPRIS = imports.service.components.mpris;
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
                this._handleUpdate(packet);
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
    _handleUpdate(packet) {
        try {
            if (packet.body.hasOwnProperty('playerList'))
                this._handlePlayerList(packet.body.playerList);
            else if (packet.body.hasOwnProperty('player'))
                this._handlePlayerUpdate(packet);
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
                let player = new PlayerRemote(this.device, identity);
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
     * @param {Object} packet - A `kdeconnect.mpris` packet
     */
    _handlePlayerUpdate(packet) {
        let player = this._players.get(packet.body.player);

        if (player === undefined)
            return;

        if (packet.body.hasOwnProperty('transferringAlbumArt'))
            player.handleAlbumArt(packet);
        else
            player.update(packet.body);
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
                await player.Seek(packet.body.Seek * 1000);

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

                // Now Playing
                if (response.body.artist && response.body.title) {
                    response.body.nowPlaying = [
                        response.body.artist,
                        response.body.title,
                    ].join(' - ');
                } else if (response.body.artist) {
                    response.body.nowPlaying = response.body.artist;
                } else if (response.body.title) {
                    response.body.nowPlaying = response.body.title;
                } else {
                    response.body.nowPlaying = _('Unknown');
                }
            }

            if (packet.body.hasOwnProperty('requestVolume')) {
                hasResponse = true;
                response.body.volume = Math.floor(player.Volume * 100);
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

    _onPlayerSeeked(mpris, player, offset) {
        // TODO: although we can handle full seeked signals, kdeconnect-android
        //       does not, and expects a position update instead
        this.device.sendPacket({
            type: 'kdeconnect.mpris',
            body: {
                player: player.Identity,
                pos: Math.floor(player.Position / 1000),
                // Seek: Math.floor(offset / 1000),
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


const PlayerRemote = GObject.registerClass({
    GTypeName: 'GSConnectMPRISPlayerRemote',
}, class PlayerRemote extends MPRIS.Player {

    _init(device, identity) {
        super._init();

        this._device = device;
        this._Identity = identity;
        this._isPlaying = false;

        this._artist = null;
        this._title = null;
        this._album = null;
        this._length = 0;
        this._artUrl = null;

        this._ownerId = 0;
        this._connection = null;
        this._applicationIface = null;
        this._playerIface = null;
    }

    _getFile(albumArtUrl) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5,
            albumArtUrl, -1);
        const path = GLib.build_filenamev([Config.CACHEDIR, hash]);

        return Gio.File.new_for_uri(`file://${path}`);
    }

    _requestAlbumArt(state) {
        if (this._artUrl === state.albumArtUrl)
            return;

        let file = this._getFile(state.albumArtUrl);

        if (file.query_exists(null)) {
            this._artUrl = file.get_uri();
            this._Metadata = undefined;
            this.notify('Metadata');
        } else {
            this.device.sendPacket({
                type: 'kdeconnect.mpris.request',
                body: {
                    player: this.Identity,
                    albumArtUrl: state.albumArtUrl,
                },
            });
        }
    }

    _updateMetadata(state) {
        let metadataChanged = false;

        if (state.hasOwnProperty('artist')) {
            if (this._artist !== state.artist) {
                this._artist = state.artist;
                metadataChanged = true;
            }
        } else if (this._artist) {
            this._artist = null;
            metadataChanged = true;
        }

        if (state.hasOwnProperty('title')) {
            if (this._title !== state.title) {
                this._title = state.title;
                metadataChanged = true;
            }
        } else if (this._title) {
            this._title = null;
            metadataChanged = true;
        }

        if (state.hasOwnProperty('album')) {
            if (this._album !== state.album) {
                this._album = state.album;
                metadataChanged = true;
            }
        } else if (this._album) {
            this._album = null;
            metadataChanged = true;
        }

        if (state.hasOwnProperty('length')) {
            if (this._length !== state.length * 1000) {
                this._length = state.length * 1000;
                metadataChanged = true;
            }
        } else if (this._length) {
            this._length = 0;
            metadataChanged = true;
        }

        if (state.hasOwnProperty('albumArtUrl')) {
            this._requestAlbumArt(state);
        } else if (this._artUrl) {
            this._artUrl = null;
            metadataChanged = true;
        }

        if (metadataChanged) {
            this._Metadata = undefined;
            this.notify('Metadata');
        }
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

    /**
     * Download album art for the current track of the remote player.
     *
     * @param {Core.Packet} packet - A `kdeconnect.mpris` packet
     */
    async handleAlbumArt(packet) {
        let file;

        try {
            file = this._getFile(packet.body.albumArtUrl);

            // Transfer the album art
            let transfer = this.device.createTransfer();
            transfer.addFile(packet, file);

            await transfer.start();

            this._artUrl = file.get_uri();
            this._Metadata = undefined;
            this.notify('Metadata');
        } catch (e) {
            debug(e, this.device.name);

            if (file)
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
        }
    }

    /**
     * Update the internal state of the media player.
     *
     * @param {Core.Packet} state - The body of a `kdeconnect.mpris` packet
     */
    update(state) {
        this.freeze_notify();

        // Metadata
        if (state.hasOwnProperty('nowPlaying'))
            this._updateMetadata(state);

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
     * The org.mpris.MediaPlayer2.Player Interface
     */
    get CanControl() {
        return (this.CanPlay || this.CanPause);
    }

    get Metadata() {
        if (this._Metadata === undefined) {
            this._Metadata = {};

            if (this._artist) {
                this._Metadata['xesam:artist'] = new GLib.Variant('as',
                    [this._artist]);
            }

            if (this._title) {
                this._Metadata['xesam:title'] = new GLib.Variant('s',
                    this._title);
            }

            if (this._album) {
                this._Metadata['xesam:album'] = new GLib.Variant('s',
                    this._album);
            }

            if (this._artUrl) {
                this._Metadata['mpris:artUrl'] = new GLib.Variant('s',
                    this._artUrl);
            }

            this._Metadata['mpris:length'] = new GLib.Variant('x',
                this._length);
        }

        return this._Metadata;
    }

    get PlaybackStatus() {
        if (this._isPlaying)
            return 'Playing';

        return 'Stopped';
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

    Next() {
        if (!this.CanGoNext)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Next',
            },
        });
    }

    Pause() {
        if (!this.CanPause)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Pause',
            },
        });
    }

    Play() {
        if (!this.CanPlay)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Play',
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

    Previous() {
        if (!this.CanGoPrevious)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.mpris.request',
            body: {
                player: this.Identity,
                action: 'Previous',
            },
        });
    }

    Seek(offset) {
        if (!this.CanSeek)
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

