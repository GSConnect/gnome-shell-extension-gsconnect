// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import Config from '../../config.js';


/**
 * The maximum size of a file or image shared through the clipboard, which is
 * the same as the default of KDE Connect.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;


/**
 * The maximum number of pixels of a received image, to limit memory use.
 */
const MAX_IMAGE_PIXELS = 25 * 1000 * 1000;


/**
 * The image formats accepted from devices, by GdkPixbuf format name, with the
 * signature their data starts with (%null matches any byte). Other formats
 * are received as files, without being decoded.
 */
const IMAGE_SIGNATURES = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff],
    gif: [0x47, 0x49, 0x46, 0x38],
    webp: [
        0x52, 0x49, 0x46, 0x46, null, null, null, null,
        0x57, 0x45, 0x42, 0x50,
    ],
    bmp: [0x42, 0x4d],
};


/**
 * The number of bytes hashed at a time, before yielding to the main loop.
 */
const CHECKSUM_CHUNK_SIZE = 4 * 1024 * 1024;


/**
 * Get the format of an image file from the signature its data starts with,
 * without passing it to an image loader.
 *
 * @param {Gio.File} file - A file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<string|null>} The GdkPixbuf name of an accepted format, or
 *   %null if the file is not an image in an accepted format
 */
export async function getImageFormat(file, cancellable = null) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);

    try {
        const bytes = await new Promise((resolve, reject) => {
            stream.read_bytes_async(12, GLib.PRIORITY_DEFAULT, cancellable,
                (_stream, res) => {
                    try {
                        resolve(stream.read_bytes_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const header = bytes.toArray();

        for (const [name, signature] of Object.entries(IMAGE_SIGNATURES)) {
            if (header.length >= signature.length &&
                signature.every((byte, i) => byte === null || byte === header[i]))
                return name;
        }

        return null;
    } finally {
        stream.close(null);
    }
}


/**
 * Load the contents of a file.
 *
 * @param {Gio.File} file - A file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GLib.Bytes>} The contents
 */
export function loadBytes(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_bytes_async(cancellable, (_file, res) => {
            try {
                resolve(file.load_bytes_finish(res)[0]);
            } catch (e) {
                reject(e);
            }
        });
    });
}


/**
 * Get the format and dimensions of an image file, without decoding it.
 *
 * @param {Gio.File} file - An image file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<Array>} The format (or %null if unsupported), the width
 *   and the height of the image
 */
function getImageInfo(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(file.get_path(), cancellable,
            (_source, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.get_file_info_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}


/**
 * Decode an image file into a pixbuf, in a worker thread.
 *
 * Images with more pixels than {@link MAX_IMAGE_PIXELS} are rejected without
 * being decoded.
 *
 * @param {Gio.File} file - An image file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @param {string} [expectedFormat] - The GdkPixbuf name of the only format
 *   accepted, if any
 * @returns {Promise<GdkPixbuf.Pixbuf>} A pixbuf
 */
export async function decodeImageFile(file, cancellable = null,
    expectedFormat = null) {
    // Check the format and dimensions before decoding the image
    const [format, width, height] = await getImageInfo(file, cancellable);

    if (format === null)
        throw new Error('Unsupported image format');

    if (expectedFormat !== null && format.get_name() !== expectedFormat)
        throw new Error(`Unexpected image format: ${format.get_name()}`);

    if (width * height > MAX_IMAGE_PIXELS)
        throw new Error(`Image is too large: ${width}x${height}`);

    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);

    try {
        const pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable,
                (_source, res) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });

        return pixbuf.apply_embedded_orientation() ?? pixbuf;
    } finally {
        stream.close(null);
    }
}


/**
 * The prefix of files holding image data while it is decoded.
 */
const IMAGE_PREFIX = 'clipboard-image-';


/**
 * The path of the directory for image data that was last cleaned up.
 */
let cleanedPath = null;


/**
 * Get the directory for image data being decoded, removing any files left
 * there by a previous instance of the service the first time.
 *
 * @returns {Gio.File} The directory
 */
function getImageDirectory() {
    const path = Config.RUNTIMEDIR;
    GLib.mkdir_with_parents(path, 448);
    const dir = Gio.File.new_for_path(path);

    if (cleanedPath === path)
        return dir;

    cleanedPath = path;

    try {
        const iter = dir.enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

        let info;
        while ((info = iter.next_file(null)) !== null) {
            if (info.get_name().startsWith(IMAGE_PREFIX))
                iter.get_child(info).delete(null);
        }

        iter.close(null);
    } catch (e) {
        debug(e);
    }

    return dir;
}


/**
 * Decode image data into a pixbuf, in a worker thread.
 *
 * Data larger than {@link MAX_FILE_SIZE}, or images with more pixels than
 * {@link MAX_IMAGE_PIXELS}, are rejected without being decoded.
 *
 * @param {GLib.Bytes} bytes - Encoded image data
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GdkPixbuf.Pixbuf>} A pixbuf
 */
export async function decodeImage(bytes, cancellable = null) {
    if (bytes.get_size() > MAX_FILE_SIZE)
        throw new Error('Image is too large');

    // The dimensions can only be read without blocking from a file, which is
    // only readable by the user
    const file = getImageDirectory().get_child(
        `${IMAGE_PREFIX}${GLib.uuid_string_random()}`);

    try {
        await file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE, cancellable);

        return await decodeImageFile(file, cancellable);
    } finally {
        file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(e => {
            debug(e);
        });
    }
}


/**
 * Encode a pixbuf as PNG data, in a worker thread.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GLib.Bytes>} PNG data
 */
export async function encodePng(pixbuf, cancellable = null) {
    const stream = Gio.MemoryOutputStream.new_resizable();

    await new Promise((resolve, reject) => {
        pixbuf.save_to_streamv_async(stream, 'png', [], [], cancellable,
            (_source, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });

    stream.close(null);

    return stream.steal_as_bytes();
}


/**
 * Get a checksum for the pixel data of a pixbuf.
 *
 * This is used to recognize an image regardless of how it was encoded. The
 * rows are hashed without the padding between them, in chunks, to avoid
 * blocking the main loop for large images.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<string>} A checksum
 */
export async function getImageChecksum(pixbuf, cancellable = null) {
    const {width, height, rowstride} = pixbuf;
    const channels = pixbuf.n_channels;
    const rowLength = width * channels * pixbuf.bits_per_sample / 8;
    const size = rowLength * height;
    const pixels = pixbuf.read_pixel_bytes();

    // The pixel data without the padding between rows is hashed in chunks,
    // and the checksum is that of their digests
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);

    const yieldChunk = async () => {
        await new Promise(resolve => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });

        cancellable?.set_error_if_cancelled();
    };

    if (rowstride === rowLength) {
        // Without padding, the chunks are hashed without copying them
        for (let offset = 0; offset < size; offset += CHECKSUM_CHUNK_SIZE) {
            const chunk = GLib.Bytes.new_from_bytes(pixels, offset,
                Math.min(CHECKSUM_CHUNK_SIZE, size - offset));
            checksum.update(new TextEncoder().encode(
                GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
                    chunk)));

            await yieldChunk();
        }
    } else {
        // Rows are copied into a buffer without their padding, so the cost
        // doesn't depend on the number of rows
        const buffer = new Uint8Array(Math.min(CHECKSUM_CHUNK_SIZE, size));
        const windowRows = Math.max(1,
            Math.floor(CHECKSUM_CHUNK_SIZE / rowstride));
        let filled = 0;

        for (let first = 0; first < height; first += windowRows) {
            const rows = Math.min(windowRows, height - first);

            // The last row of a pixbuf may not be padded
            const window = GLib.Bytes.new_from_bytes(pixels, first * rowstride,
                (rows - 1) * rowstride + rowLength).toArray();

            for (let y = 0; y < rows; y++) {
                let offset = y * rowstride;
                let remaining = rowLength;

                while (remaining > 0) {
                    const length = Math.min(remaining, buffer.length - filled);

                    // Copying short rows byte by byte avoids creating many
                    // views
                    if (length < 64) {
                        for (let i = 0; i < length; i++)
                            buffer[filled + i] = window[offset + i];
                    } else {
                        buffer.set(window.subarray(offset, offset + length),
                            filled);
                    }

                    filled += length;
                    offset += length;
                    remaining -= length;

                    if (filled === buffer.length) {
                        checksum.update(new TextEncoder().encode(
                            GLib.compute_checksum_for_data(
                                GLib.ChecksumType.SHA256, buffer)));
                        filled = 0;

                        await yieldChunk();
                    }
                }
            }
        }

        if (filled > 0) {
            checksum.update(new TextEncoder().encode(
                GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256,
                    buffer.subarray(0, filled))));
        }
    }

    return `${width}x${height}x${channels}:${checksum.get_string()}`;
}
