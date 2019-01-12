"""
nautilus-gsconnect.py - A Nautilus extension for sending files via GSConnect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script 'kdeconnect-send-nautilus.py':

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

import gettext
import locale
import os.path

import gi
gi.require_version('Nautilus', '3.0')
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
gi.require_version('GObject', '2.0')
from gi.repository import Nautilus, Gio, GLib, GObject

_ = gettext.gettext

USER_DIR = os.path.join(GLib.get_user_data_dir(),
                        'gnome-shell/extensions/gsconnect@andyholmes.github.io')

if os.path.exists(USER_DIR):
    LOCALE_DIR = os.path.join(USER_DIR, 'locale')
else:
    LOCALE_DIR = None


SERVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect'
SERVICE_PATH = '/org/gnome/Shell/Extensions/GSConnect'



class GSConnectShareExtension(GObject.Object, Nautilus.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize the translations and DBus ObjectManager"""

        GObject.Object.__init__(self)

        # Prepare the translations
        try:
            locale.setlocale(locale.LC_ALL, '')
            gettext.bindtextdomain(SERVICE_NAME, LOCALE_DIR)
        except:
            pass

        self.devices = {}

        # Initialize an ObjectManager asynchronously
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
                                  Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                                  None,
                                  'org.gnome.Shell.Extensions.GSConnect',
                                  '/org/gnome/Shell/Extensions/GSConnect',
                                  'org.freedesktop.DBus.ObjectManager',
                                  None,
                                  self._init_async,
                                  None)

    def _init_async(self, proxy, res, user_data):
        proxy = proxy.new_for_bus_finish(res)
        proxy.connect('notify::g-name-owner', self._on_name_owner_changed)
        proxy.connect('g-signal', self._on_g_signal)

        self._on_name_owner_changed(proxy, None)

    def _on_g_signal(self, proxy, sender_name, signal_name, parameters):
        # Wait until the service is ready
        if proxy.props.g_name_owner is None:
            return

        objects = parameters.unpack()

        if signal_name == 'InterfacesAdded':
            for object_path, props in objects.items():
                props = props['org.gnome.Shell.Extensions.GSConnect.Device']

                self.devices[object_path] = (props['Name'],
                                             Gio.DBusActionGroup.get(
                                                 proxy.get_connection(),
                                                 SERVICE_NAME,
                                                 object_path))
        elif signal_name == 'InterfacesRemoved':
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
            proxy.call('GetManagedObjects',
                       None,
                       Gio.DBusCallFlags.NO_AUTO_START,
                       -1,
                       None,
                       self._get_managed_objects,
                       None)

    def _get_managed_objects(self, proxy, res, user_data):
        objects = proxy.call_finish(res)[0]

        for object_path, props in objects.items():
            props = props['org.gnome.Shell.Extensions.GSConnect.Device']

            self.devices[object_path] = (props['Name'],
                                         Gio.DBusActionGroup.get(
                                             proxy.get_connection(),
                                             SERVICE_NAME,
                                             object_path))

    def send_files(self, menu, files, action_group):
        """Send *files* to *device_id*"""

        for file in files:
            variant = GLib.Variant('(sb)', (file.get_uri(), False))
            action_group.activate_action('shareFile', variant)

    def get_file_items(self, window, files):
        """Return a list of select files to be sent"""

        # Only accept regular files
        for uri in files:
            if uri.get_uri_scheme() != 'file' or uri.is_directory():
                return ()

        # Enumerate capable devices
        devices = []

        for name, action_group in self.devices.values():
            if action_group.get_action_enabled('shareFile'):
                devices.append([name, action_group])

        # No capable devices; don't show menu entry
        if not devices:
            return ()

        # Context Menu Item
        menu = Nautilus.MenuItem(
            name='GSConnectShareExtension::Devices',
            label=_('Send To Mobile Device')
        )

        # Context Submenu
        submenu = Nautilus.Menu()
        menu.set_submenu(submenu)

        # Context Submenu Items
        for name, action_group in devices:
            item = Nautilus.MenuItem(
                name='GSConnectShareExtension::Device' + name,
                label=name
            )

            item.connect('activate', self.send_files, files, action_group)

            submenu.append_item(item)

        return (menu,)

