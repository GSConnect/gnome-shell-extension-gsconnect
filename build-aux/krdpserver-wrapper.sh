#!/bin/sh

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

set -eu

RUNTIME_BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RUNTIME_ROOT=$(dirname -- "${RUNTIME_BIN_DIR}")

if [ -n "${LD_LIBRARY_PATH:-}" ]; then
    LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib:${LD_LIBRARY_PATH}"
else
    LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib"
fi

export LD_LIBRARY_PATH
exec "${RUNTIME_ROOT}/libexec/krdpserver" "$@"
