# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""
nautilus-gsconnect.py - A Nautilus extension for sending files via GSConnect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script 'kdeconnect-send-nautilus.py':

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

import os.path
import pathlib
import sys
import tempfile
import zipfile
import typing as T
from gettext import translation, GNUTranslations, NullTranslations

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
gi.require_version("GObject", "2.0")
from gi.repository import Gio, GLib, GObject


# Host application detection
#
# Nemo seems to reliably identify itself as 'nemo' in argv[0], so we
# can test for that. Nautilus detection is less reliable, so don't try.
# See https://github.com/linuxmint/nemo-extensions/issues/330
if "nemo" in sys.argv[0].lower():
    # Host runtime is nemo-python
    gi.require_version("Nemo", "3.0")
    from gi.repository import Nemo as FileManager
else:
    # Otherwise, just assume it's nautilus-python
    from gi.repository import Nautilus as FileManager


SERVICE_NAME = "org.gnome.Shell.Extensions.GSConnect"
SERVICE_PATH = "/org/gnome/Shell/Extensions/GSConnect"

# Init gettext translations
locale_path = os.path.join(
    GLib.get_user_data_dir(),
    "gnome-shell",
    "extensions",
    "gsconnect@andyholmes.github.io",
    "locale",
)
LOCALE_DIR = locale_path if os.path.exists(locale_path) else None

i18n: GNUTranslations | NullTranslations = NullTranslations()
try:
    i18n = translation(SERVICE_NAME, localedir=LOCALE_DIR)
except (IOError, OSError) as e:
    print(f"GSConnect: {e}", file=sys.stdout)
    i18n = translation(
        SERVICE_NAME, localedir=LOCALE_DIR, fallback=True
    )

_ = i18n.gettext


class GSConnectShareExtension(GObject.Object, FileManager.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize the DBus ObjectManager."""
        GObject.Object.__init__(self)

        self.devices = {}
        self.tempdir = None

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            None,
            SERVICE_NAME,
            SERVICE_PATH,
            "org.freedesktop.DBus.ObjectManager",
            None,
            self._init_async,
            None,
        )

    def _init_async(self, proxy, res, user_data):
        proxy = proxy.new_for_bus_finish(res)
        proxy.connect("notify::g-name-owner", self._on_name_owner_changed)
        proxy.connect("g-signal", self._on_g_signal)

        self._on_name_owner_changed(proxy, None)

    def _on_g_signal(self, proxy, sender_name, signal_name, parameters):
        # Wait until the service is ready
        if proxy.props.g_name_owner is None:
            return

        objects = parameters.unpack()

        if signal_name == "InterfacesAdded":
            for object_path, props in objects.items():
                props = props["org.gnome.Shell.Extensions.GSConnect.Device"]

                self.devices[object_path] = (
                    props["Name"],
                    Gio.DBusActionGroup.get(
                        proxy.get_connection(), SERVICE_NAME, object_path
                    ),
                )
        elif signal_name == "InterfacesRemoved":
            for object_path in objects:
                try:
                    del self.devices[object_path]
                except KeyError:
                    pass

    def _on_name_owner_changed(self, proxy, pspec):
        # Wait until the service is ready
        if proxy.props.g_name_owner is None:
            self.devices = {}
        else:
            proxy.call(
                "GetManagedObjects",
                None,
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                None,
                self._get_managed_objects,
                None,
            )

    def _get_managed_objects(self, proxy, res, user_data):
        objects = proxy.call_finish(res)[0]

        for object_path, props in objects.items():
            props = props["org.gnome.Shell.Extensions.GSConnect.Device"]
            if not props:
                continue

            self.devices[object_path] = (
                props["Name"],
                Gio.DBusActionGroup.get(
                    proxy.get_connection(), SERVICE_NAME, object_path
                ),
            )

    def make_temporary_zipfile(self, dir):
        """Recursively walk ``dir`` and create a zipfile, returning its URI."""
        if self.tempdir is None:
            self.tempdir = tempfile.mkdtemp(prefix='gsconnect')
        dirpath = pathlib.Path(dir)
        zippath = pathlib.Path(self.tempdir) / dirpath.with_suffix('.zip').name
        with zipfile.ZipFile(zippath, "w") as z:
            for parent, subdirs, subfiles in dirpath.walk():
                # Create directory entries, to include empty directories
                indir = parent.resolve()
                arcdir = parent.relative_to(dirpath.parent)
                z.write(indir, arcname=arcdir)
                for file in subfiles:
                    try:
                        infile = indir / file
                        arcfile = arcdir / file
                        z.write(infile, arcname=str(arcfile))
                    except OSError as e:
                        print(
                            f"GSConnect: Can't add {arcfile} to zip: {e}",
                            file=sys.stderr)
                        continue
        return zippath.as_uri()

    def send_files(
            self, menu, selected: list[FileManager.FileInfo], action_group):
        """Send *files* to *device_id*."""
        all_files = set(selected)

        if not all_files:
            return

        dirs = set(filter(lambda f: f.is_directory(), all_files))
        files = all_files - dirs

        file_uris = [f.get_uri() for f in files]

        if files and not dirs:
            files_variant = GLib.Variant("(asb)", (file_uris, False))
            action_group.activate_action("shareFiles", files_variant)
            return

        # Handle temporary zip files for dirs
        # XXX: This currently names the zipfiles 'basename.zip' and
        #      DOES NOT handle collisions. Don't try to send two
        #      directories both named "Documents". The two
        #      "Documents.zip" archives will overwrite each other!
        zip_uris = [
            self.make_temporary_zipfile(dir.get_location().get_path())
            for dir in dirs
        ]
        file_uris.extend(zip_uris)
        mixed_variant = GLib.Variant("(asas)", (file_uris, zip_uris))
        action_group.activate_action("shareFilesWithTemps", mixed_variant)

    def get_file_items(self, *args):
        """Return a list of select files to be sent."""
        # 'args' will depend on the Nautilus API version.
        # * Nautilus 4.0:
        #     `[files: List[Nautilus.FileInfo]]`
        # * Nautilus 3.0:
        #     `[window: Gtk.Widget, files: List[Nautilus.FileInfo]]`
        files = set(args[-1])

        # Only accept regular files
        for uri in files:
            if uri.get_uri_scheme() != "file":
                return ()

        # Enumerate capable devices
        devices = {
            name: action_group
            for name, action_group in self.devices.values()
            if action_group.get_action_enabled("shareFile")
        }

        # No capable devices; don't show menu entry
        if not devices:
            return ()

        # Context Submenu Items
        def make_submenu_item(name, action_group, files):
            """Generate a send-to-device context menu item."""
            item = FileManager.MenuItem(
                name="GSConnectShareExtension::Device" + name, label=name
            )
            item.connect("activate", self.send_files, list(files), action_group)
            return item
        submenu_items = {
            name: make_submenu_item(name, action_group, files)
            for name, action_group in devices.items()
        }

        if len(submenu_items) == 1:
            # Single entry for FileManager econtext menu
            name, menu = submenu_items.popitem()
            # TRANSLATORS: Send to <device_name>, for file manager
            # context menu
            menu.set_label(_("Send to %s") % name)
        else:
            # Submenu for FileManager context menu
            menu = FileManager.MenuItem(
                name="GSConnectShareExtension::Devices",
                label=_("Send To Mobile Device"),
            )
            submenu = FileManager.Menu()
            menu.set_submenu(submenu)
            for item in submenu_items.values():
                submenu.append_item(item)

        return (menu,)
