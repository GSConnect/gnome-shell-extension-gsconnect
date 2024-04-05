// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import Config from '../config.js';
const DBus = await import(`file://${Config.PACKAGE_DATADIR}/service/utils/dbus.js`);
const MPRIS = await import(`file://${Config.PACKAGE_DATADIR}/service/components/mpris.js`);


/*
 * A class for mirroring a remote Media Player on DBus
 */
const MPRISIface = Config.DBUS.lookup_interface('org.mpris.MediaPlayer2');
const MPRISPlayerIface = Config.DBUS.lookup_interface('org.mpris.MediaPlayer2.Player');


const MockPlayer = GObject.registerClass({
    GTypeName: 'GSConnectMockPlayer',
}, class MockPlayer extends MPRIS.Player {

    _init(identity) {
        super._init();

        this._Identity = identity;

        this._ownerId = 0;
        this._connection = null;
        this._applicationIface = null;
        this._playerIface = null;
    }

    async export() {
        if (this._connection === null) {
            this._connection = await DBus.newConnection();

            this._applicationIface = new DBus.Interface({
                g_instance: this,
                g_connection: this._connection,
                g_object_path: '/org/mpris/MediaPlayer2',
                g_interface_info: MPRISIface,
            });

            this._playerIface = new DBus.Interface({
                g_instance: this,
                g_connection: this._connection,
                g_object_path: '/org/mpris/MediaPlayer2',
                g_interface_info: MPRISPlayerIface,
            });
        }

        if (this._ownerId !== 0)
            return;

        const name = this.Identity.replace(/\W*/g, '_');

        this._ownerId = Gio.bus_own_name_on_connection(
            this._connection,
            `org.mpris.MediaPlayer2.${name}`,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null
        );
    }

    unexport() {
        if (this._ownerId === 0)
            return;

        Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
    }

    get Metadata() {
        if (this._Metadata === undefined)
            this._Metadata = {};

        return this._Metadata;
    }

    Play() {
        printerr(`Play(): ${this.PlaybackStatus}`);

        if (this.PlaybackStatus === 'Playing')
            return;

        printerr('Play()');

        this._PlaybackStatus = 'Playing';
        this.notify('PlaybackStatus');
    }

    Pause() {
        if (this.PlaybackStatus !== 'Playing')
            return;

        this._PlaybackStatus = 'Paused';
        this.notify('PlaybackStatus');
    }

    Seek(offset) {
        if (!this.CanSeek)
            return;

        this.emit('Seeked', offset);
    }

    destroy() {
        this.unexport();

        if (this._connection) {
            this._connection.close(null, null);
            this._connection = null;

            this._applicationIface.destroy();
            this._applicationIface = null;

            this._playerIface.destroy();
            this._playerIface = null;
        }
    }
});

export default MockPlayer;

