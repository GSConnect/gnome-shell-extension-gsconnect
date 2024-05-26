#!/bin/env sh

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

case "$0" in
    */*) EXTENSION_DIR=$(dirname $(realpath "$0")) ;;
    *) EXTENSION_DIR=$(dirname $(realpath $(which $0))) ;;
esac
exec /bin/env gjs -m "${EXTENSION_DIR}/preferences-app.js" "$@"

