"""
nautilus-gsconnect.py - A Nautilus extension for sending files via GSConnect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script "kdeconnect-send-nautilus.py":

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

from gettext import translation
from os.path import join, exists
from sys import argv

import gi
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
gi.require_version("GObject", "2.0")
from gi.repository.Gio import (
    DBusProxy, DBusProxyFlags, BusType, DBusActionGroup, DBusCallFlags)
from gi.repository.GLib import get_user_data_dir, Variant
from gi.repository.GObject import Object


# Host application detection
#
# Nemo seems to reliably identify itself as "nemo" in argv[0], so we
# can test for that. Nautilus detection is less reliable, so don't try.
# See https://github.com/linuxmint/nemo-extensions/issues/330
if "nemo" in argv[0].lower():
    # Host runtime is nemo-python
    gi.require_version("Nemo", "3.0")
    from gi.repository import Nemo as FileManager
else:
    # Otherwise, just assume it's nautilus-python
    from gi.repository import Nautilus as FileManager


SERVICE_NAME = "org.gnome.Shell.Extensions.GSConnect"
SERVICE_PATH = "/org/gnome/Shell/Extensions/GSConnect"

# Init gettext translations
LOCALE_DIR = join(
    get_user_data_dir(), "gnome-shell", "extensions",
    "gsconnect@andyholmes.github.io", "locale")

if not exists(LOCALE_DIR):
    LOCALE_DIR = None

try:
    i18n = translation(SERVICE_NAME, localedir=LOCALE_DIR)
    _ = i18n.gettext
except (IOError, OSError) as error:
    print(f"GSConnect: {error.strerror}")
    i18n = translation(SERVICE_NAME, localedir=LOCALE_DIR, fallback=True)
    _ = i18n.gettext


class GSConnectShareExtension(Object, FileManager.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize the DBus ObjectManager"""
        Object.__init__(self)
        self.devices = dict()
        DBusProxy.new_for_bus(
            BusType.SESSION, DBusProxyFlags.DO_NOT_AUTO_START, None,
            SERVICE_NAME, SERVICE_PATH, "org.freedesktop.DBus.ObjectManager",
            None, self._init_async, None)

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
                    props["Name"], DBusActionGroup.get(
                        proxy.get_connection(), SERVICE_NAME, object_path))
        elif signal_name == "InterfacesRemoved":
            for object_path in objects:
                try:
                    del self.devices[object_path]
                except KeyError:
                    pass

    def _on_name_owner_changed(self, proxy, pspec):
        # Wait until the service is ready
        if proxy.props.g_name_owner is None:
            self.devices = dict()
        else:
            proxy.call(
                "GetManagedObjects", None, DBusCallFlags.NO_AUTO_START, -1,
                None, self._get_managed_objects, None)

    def _get_managed_objects(self, proxy, res, user_data):
        objects = proxy.call_finish(res)[0]

        for object_path, props in objects.items():
            props = props["org.gnome.Shell.Extensions.GSConnect.Device"]
            if not props:
                continue
            self.devices[object_path] = (
                props["Name"], DBusActionGroup.get(
                    proxy.get_connection(), SERVICE_NAME, object_path))

    def send_files(self, menu, files, action_group):
        """Send *files* to *device_id*"""

        for file in files:
            variant = Variant("(sb)", (file.get_uri(), False))
            action_group.activate_action("shareFile", variant)

    def get_file_items(self, *args):
        # `args` will be `[files: List[Nautilus.FileInfo]]` in Nautilus 4.0 API,
        # and `[window: Gtk.Widget, files: List[Nautilus.FileInfo]]` in Nautilus 3.0 API.
        files = args[-1]
        """Return a list of select files to be sent"""

        # Only accept regular files
        for uri in files:
            if uri.get_uri_scheme() != "file" or uri.is_directory():
                return tuple()

        # Enumerate capable devices
        devices = list()

        for name, action_group in self.devices.values():
            if action_group.get_action_enabled("shareFile"):
                devices.append([name, action_group])

        # No capable devices; don't show menu entry
        if not devices:
            return tuple()

        # Context Menu Item
        menu = FileManager.MenuItem(
            name="GSConnectShareExtension::Devices",
            label=_("Send To Mobile Device"))

        # Context Submenu
        submenu = FileManager.Menu()
        menu.set_submenu(submenu)

        # Context Submenu Items
        for name, action_group in devices:
            item = FileManager.MenuItem(
                name="GSConnectShareExtension::Device" + name, label=name)
            item.connect("activate", self.send_files, files, action_group)
            submenu.append_item(item)

        return (menu,)
