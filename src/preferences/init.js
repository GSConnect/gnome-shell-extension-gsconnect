// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {setup, setupGettext} from '../utils/setup.js';


// Bootstrap
setup(GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])));
setupGettext();
