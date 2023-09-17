// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

const [filename] = GLib.filename_from_uri(import.meta.url);
const dirname = GLib.path_get_dirname(filename);
imports.searchPath.unshift(dirname);

const Config = imports.config;
export default Config;
