// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

export class MissingOpensslError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MissingOpensslError';
    }
}
