// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import Config from '../config.js';
const {Clipboard: Portal} = await import(
    `file://${Config.PACKAGE_DATADIR}/wl_clipboard.js`
);
const {default: Clipboard} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/components/clipboard.js`
);


/*
 * Stand-ins for wl-copy and wl-paste, which keep the clipboard in a
 * directory. Each value is written to a new directory, which a symbolic link
 * points to once complete, and the types copied are logged in order.
 */
const WL_COPY = `#!/bin/sh
type=text/plain
[ "$1" = --type ] && type=$2
echo "$type" >> "$WL_STUB_DIR/copies"
[ "$type" = "$WL_STUB_SLOW_TYPE" ] && sleep 0.5
value=$(mktemp -d "$WL_STUB_DIR/value.XXXXXX")
cat > "$value/data"
printf %s "$type" > "$value/type"
ln -sfn "$value" "$WL_STUB_DIR/current.new"
mv -T "$WL_STUB_DIR/current.new" "$WL_STUB_DIR/current"
`;

const WL_PASTE = `#!/bin/sh
current="$WL_STUB_DIR/current"
case "$1" in
    -w)
        shift
        last=
        # Stop with the test, like wl-paste with the compositor
        while kill -0 $PPID 2>/dev/null; do
            now=$(readlink "$current")
            if [ "$now" != "$last" ]; then
                last=$now
                "$@"
            fi
            sleep 0.05
        done
        ;;
    --list-types)
        [ -e "$current" ] || exit 1
        cat "$current/type"
        echo
        ;;
    *)
        type=
        while [ $# -gt 0 ]; do
            [ "$1" = --type ] && { type=$2; shift; }
            shift
        done

        if [ "$type" = "$WL_STUB_HANG_TYPE" ]; then
            # Like an application that doesn't send the clipboard
            echo $$ > "$WL_STUB_DIR/hung"
            exec sleep 60
        fi
        [ -e "$current" ] || exit 1
        [ "$type" = "$(cat "$current/type")" ] || exit 1
        cat "$current/data"
        ;;
esac
`;


/*
 * The portal is tested on the session bus, where it must not replace the
 * clipboard of GNOME Shell or of a running service, which would change the
 * clipboard of the desktop
 */
/*
 * A type only read by the tests, which the stand-in for wl-paste doesn't send
 * if set as WL_STUB_HANG_TYPE, unlike the types read by the clipboard
 */
const HANG_TYPE = 'application/x-gsconnect-test';

const PORTAL_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const [portalRunning] = Gio.DBus.session.call_sync('org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
    new GLib.Variant('(s)', [PORTAL_NAME]), new GLib.VariantType('(b)'),
    Gio.DBusCallFlags.NONE, -1, null).deepUnpack();


/**
 * Write an executable file.
 *
 * @param {string} path - The path
 * @param {string} contents - The contents
 */
function writeExecutable(path, contents) {
    GLib.file_set_contents(path, contents);
    GLib.chmod(path, 0o755);
}


/**
 * Copy a value to the clipboard from another application.
 *
 * @param {Uint8Array} data - The value
 * @param {string} type - The mimetype
 */
async function copyElsewhere(data, type) {
    const proc = Gio.Subprocess.new(['wl-copy', '--type', type],
        Gio.SubprocessFlags.STDIN_PIPE);

    await new Promise((resolve, reject) => {
        proc.communicate_async(new GLib.Bytes(data), null, (proc_, res) => {
            try {
                proc_.communicate_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}


/**
 * Get the value of the clipboard through the portal.
 *
 * @param {Gio.DBusProxy} proxy - A proxy for the portal
 * @param {string} type - The mimetype
 * @returns {Promise<GLib.Variant>} The reply
 */
function getValue(proxy, type) {
    return proxy.call('GetValue', new GLib.Variant('(s)', [type]),
        Gio.DBusCallFlags.NONE, -1, null);
}


/**
 * Check whether a process exists, which it doesn't once it was reaped.
 *
 * @param {number} pid - A process ID
 * @returns {boolean} Whether the process exists
 */
function processExists(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}


(portalRunning ? xdescribe : describe)('The wl-clipboard portal', function () {
    const PNG = GLib.file_get_contents(Utils.getDataPath('album.png'))[1];
    let tmpdir, stubDir, path, haveGnome;
    let settings, portal, clipboard;

    /**
     * Read the current value of the stand-in clipboard.
     *
     * @returns {Array} The mimetype and data, or %null if there is none
     */
    function currentValue() {
        try {
            const dir = GLib.build_filenamev([stubDir, 'current']);
            const type = GLib.file_get_contents(`${dir}/type`)[1];
            const data = GLib.file_get_contents(`${dir}/data`)[1];

            return [new TextDecoder().decode(type), data];
        } catch {
            return null;
        }
    }

    /**
     * Get the types copied so far, in order.
     *
     * @returns {string[]} The mimetypes
     */
    function copies() {
        try {
            const log = GLib.file_get_contents(`${stubDir}/copies`)[1];

            return new TextDecoder().decode(log).split('\n')
                .filter(type => type.length > 0);
        } catch {
            return [];
        }
    }

    /**
     * Get the process ID of the last wl-paste that didn't send the clipboard.
     *
     * @returns {number} A process ID, or 0 if there is none yet
     */
    function hungPid() {
        try {
            const pid = GLib.file_get_contents(`${stubDir}/hung`)[1];

            return parseInt(new TextDecoder().decode(pid));
        } catch {
            return 0;
        }
    }

    beforeAll(async function () {
        tmpdir = Utils.isolateDirectories();

        stubDir = GLib.build_filenamev([tmpdir, 'wl-clipboard']);
        const binDir = GLib.build_filenamev([tmpdir, 'bin']);
        GLib.mkdir_with_parents(stubDir, 0o700);
        GLib.mkdir_with_parents(binDir, 0o700);
        writeExecutable(`${binDir}/wl-copy`, WL_COPY);
        writeExecutable(`${binDir}/wl-paste`, WL_PASTE);

        path = GLib.getenv('PATH');
        GLib.setenv('PATH', `${binDir}:${path}`, true);
        GLib.setenv('WL_STUB_DIR', stubDir, true);

        // The portal is used outside of GNOME
        haveGnome = globalThis.HAVE_GNOME;
        globalThis.HAVE_GNOME = false;

        Gtk.init(null);

        settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
        });
        settings.set_boolean('clipboard-files', true);

        portal = new Portal();
        clipboard = new Clipboard();

        await Utils.waitFor(() => clipboard._clipboard instanceof Gio.DBusProxy);
    });

    afterAll(function () {
        clipboard?.destroy();
        portal?.destroy();
        settings?.reset('clipboard-files');

        globalThis.HAVE_GNOME = haveGnome;
        GLib.setenv('PATH', path, true);
        GLib.unsetenv('WL_STUB_DIR');
        GLib.unsetenv('WL_STUB_HANG_TYPE');
        Utils.removeDirectory(tmpdir);
    });

    it('reads text copied elsewhere', async function () {
        await copyElsewhere(new TextEncoder().encode('copied elsewhere'),
            'text/plain;charset=utf-8');

        await Utils.waitFor(() => clipboard.content?.text === 'copied elsewhere');
    });

    it('sets text', async function () {
        clipboard.text = 'set as text';

        await Utils.waitFor(() => clipboard.content?.text === 'set as text');

        const [type, data] = currentValue();
        expect(type).toBe('text/plain;charset=utf-8');
        expect(new TextDecoder().decode(data)).toBe('set as text');
    });

    it('reads images copied elsewhere', async function () {
        await copyElsewhere(PNG, 'image/png');
        await Utils.waitFor(() => clipboard.content?.type === 'image');

        const image = await clipboard.getImage();
        expect(image.bytes.get_size()).toBeGreaterThan(0);
        expect(image.checksum).toEqual(jasmine.any(String));
    });

    it('sets images', async function () {
        clipboard.text = 'before the image';
        await Utils.waitFor(() => clipboard.content?.type === 'text');

        await clipboard.setImage(new GLib.Bytes(PNG));
        await Utils.waitFor(() => clipboard.content?.type === 'image');

        const [type, data] = currentValue();
        expect(type).toBe('image/png');
        expect(data).toEqual(PNG);
    });

    it('sets files', async function () {
        const uri = Utils.getDataUri('album.png');
        clipboard.setFile(uri);

        await Utils.waitFor(() => clipboard.content?.type === 'file');
        expect(clipboard.content.uri).toBe(uri);

        const [type, data] = currentValue();
        expect(type).toBe('text/uri-list');
        expect(new TextDecoder().decode(data).trim()).toBe(uri);
    });

    it('refuses values that are too large', async function () {
        const data = new Uint8Array(50 * 1024 * 1024 + 1);
        data.set(PNG);

        await copyElsewhere(data, 'image/png');
        await Utils.waitFor(() => clipboard.content?.type === 'image');

        try {
            await getValue(clipboard._clipboard, 'image/png');
            fail('The value was read');
        } catch (e) {
            expect(e.matches(Gio.DBusError, Gio.DBusError.LIMITS_EXCEEDED))
                .withContext(e.message).toBeTrue();
        }

        // The clipboard is still read afterwards
        await copyElsewhere(new TextEncoder().encode('after the image'),
            'text/plain;charset=utf-8');
        await Utils.waitFor(() => clipboard.content?.text === 'after the image');
    });

    it('keeps the last of values set in quick succession', async function () {
        const before = copies().length;
        GLib.setenv('WL_STUB_SLOW_TYPE', 'image/png', true);

        try {
            portal.SetValue(PNG, 'image/png');
            portal.SetText('superseded');
            portal.SetText('last');

            await Utils.waitFor(() => !portal._copying);
        } finally {
            GLib.unsetenv('WL_STUB_SLOW_TYPE');
        }

        const [type, data] = currentValue();
        expect(type).toBe('text/plain;charset=utf-8');
        expect(new TextDecoder().decode(data)).toBe('last');

        // A value superseded while another one is copied is not copied
        expect(copies().slice(before)).toEqual([
            'image/png',
            'text/plain;charset=utf-8',
        ]);
    });

    it('stops reading a clipboard that is not sent', async function () {
        GLib.unlink(`${stubDir}/hung`);
        GLib.setenv('WL_STUB_HANG_TYPE', HANG_TYPE, true);
        portal._pasteTimeout = 200;

        try {
            await getValue(clipboard._clipboard, HANG_TYPE);
            fail('The value was read');
        } catch (e) {
            expect(e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
                .withContext(e.message).toBeTrue();
        } finally {
            GLib.unsetenv('WL_STUB_HANG_TYPE');
            portal._pasteTimeout = 20000;
        }

        const pid = hungPid();
        expect(pid).toBeGreaterThan(0);
        await Utils.waitFor(() => !processExists(pid));
        await Utils.waitFor(() => portal._pastes.size === 0);
    });

    // This must be the last test, since it destroys the portal
    it('stops reading the clipboard when destroyed', async function () {
        GLib.unlink(`${stubDir}/hung`);
        GLib.setenv('WL_STUB_HANG_TYPE', HANG_TYPE, true);

        let read;

        try {
            read = portal._wlPaste(['--type', HANG_TYPE]);
            await Utils.waitFor(() => hungPid() > 0);
        } finally {
            GLib.unsetenv('WL_STUB_HANG_TYPE');
        }

        const pid = hungPid();
        portal.destroy();
        portal = null;

        await expectAsync(read).toBeRejected();
        await Utils.waitFor(() => !processExists(pid));
    });
});
