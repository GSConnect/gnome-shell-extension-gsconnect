// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import '../config.js';
const Config = globalThis.GSConnectLegacyExports.Config;

export class LockscreenRemoteAccess {

    constructor() {
        this._inhibitor = null;
        this._settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                null
            ),
            path: '/org/gnome/shell/extensions/gsconnect/',
        });
    }

    patchInhibitor() {
        if (this._inhibitor)
            return;

        if (this._settings.get_boolean('keep-alive-when-locked')) {
            this._inhibitor = global.backend.get_remote_access_controller().inhibit_remote_access;
            global.backend.get_remote_access_controller().inhibit_remote_access = () => {};
        }
    }

    unpatchInhibitor() {
        if (!this._inhibitor)
            return;
        global.backend.get_remote_access_controller().inhibit_remote_access = this._inhibitor;
        this._inhibitor = null;
    }
};
