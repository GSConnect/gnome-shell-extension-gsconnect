#!/bin/env sh

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

# To use this script as a `gsconnect-preferences` command from any
# directory (e.g. $HOME/.local/bin, /usr/local/bin/, or somewhere else
# on your $PATH), you can SYMLINK (do not copy!) it into that location.
#
# e.g:
# D="$HOME/.local/share/gnome-shell/extensions/gsconect@anyholmes.github.io"
# ln -s $D/gsconnect-preferences.sh $HOME/.local/bin/gsconnect-preferences

case "$0" in
    */*) EXTENSION_DIR=$(dirname $(realpath "$0")) ;;
    *) EXTENSION_DIR=$(dirname $(realpath $(which $0))) ;;
esac
if [ ! -f "${EXTENSION_DIR}/preferences-app.js" ]; then
    >&2 echo "Cannot find preferences-app.js relative to script location!"
    >&2 echo "Perhaps you copied the script instead of symlinking it?"
    exit -1
fi
exec /bin/env gjs -m "${EXTENSION_DIR}/preferences-app.js" "$@"
