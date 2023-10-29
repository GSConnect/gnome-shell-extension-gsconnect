// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';

import Config from '../config.js';
import setup, {setupGettext} from '../utils/setup.js';


// Bootstrap
setup(GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])));
setupGettext();

// FIXME: We shouldn't need to import Gvc in the first place in the preferences source code
if (Config.IS_USER) {
    // Infer libdir by assuming gnome-shell shares a common prefix with gjs;
    // assume the parent directory if it's not there
    let libdir = GIRepository.Repository.get_search_path().find(path => {
        return path.endsWith('/gjs/girepository-1.0');
    }).replace('/gjs/girepository-1.0', '');

    const gsdir = GLib.build_filenamev([libdir, 'gnome-shell']);

    if (!GLib.file_test(gsdir, GLib.FileTest.IS_DIR)) {
        const currentDir = `/${GLib.path_get_basename(libdir)}`;
        libdir = libdir.replace(currentDir, '');
    }

    Config.GNOME_SHELL_LIBDIR = libdir;
}
