// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

export class DependencyError extends Error {
    constructor(dependency, message) {
        super(message);
        this.name = 'DependencyError';
        this.dependency = dependency;
    }
}
