// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later


/**
 * Sanitize a name when creating as a directory (or symlink, etc.)
 *
 * Note: %name CANNOT be a full path, as all of its path separators
 *       will be replaced as part of sanitization.
 *
 * @param {string} name - The name to sanitize
 * @returns {string} The sanitized name
 */
export function safe_dirname(name) {
    let safe_name = name.replace('/', '∕');
    if (safe_name === '.')
        safe_name = '·';
    else if (safe_name === '..')
        safe_name = '··';
    return safe_name;
}
