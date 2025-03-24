/**
 * Return the index within filename from which the extension starts,
 * handling some common double extensions like .tar.gz, .<ext>.bak, etc
 *
 * @param {string} filename - The filename to get extension index of
 * @returns {number} the index from which extension starts
 */
export function getExtensionIndex(filename) {
    const doubleExtensions = ['gz', 'xz', 'bz2', 'bak', 'in'];
    for (let i = filename.length - 1; i >= 0; i--) {
        if (filename[i] === '.') {
            const extension = filename.slice(i + 1);
            if (!doubleExtensions.includes(extension))
                return i;
        }
    }
    return -1;
}

/**
 * Make a filename unique by adding a " (1)" after the name.
 * Increment n if the name is already in the style "<basename> (n).<ext>"
 *
 * @param {string} filename - The filename to make unique
 * @returns {number} the new filename with " (n)" added/incremented
 */
export function makeUnique(filename) {
    let extension = '';
    const i = getExtensionIndex(filename);
    if (i !== -1) {
        extension = filename.substring(i);
        filename = filename.substring(0, i);
    }

    const length = filename.length;
    if (filename[length - 3] === '(' &&
        !Number.isNaN(filename[length - 2]) &&
        filename[length - 1] === ')') {
        const num = parseInt(filename[length - 2]);
        return `${filename.substring(0, length - 3)}(${num + 1})${extension}`;
    } else {
        return `${filename} (1)${extension}`;
    }
}

