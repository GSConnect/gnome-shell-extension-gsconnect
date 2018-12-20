"""
nautilus-gsconnect.py - A Nautilus extension for sending files via GSConnect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script 'kdeconnect-send-nautilus.py':

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

import gi
gi.require_version('Nautilus', '3.0')
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
gi.require_version('GObject', '2.0')
from gi.repository import Nautilus, Gio, GLib, GObject

import gettext
import locale
import os.path
import subprocess

_ = gettext.gettext

USER_DIR = os.path.join(GLib.get_user_data_dir(),
                        'gnome-shell/extensions/gsconnect@andyholmes.github.io')

if os.path.exists(USER_DIR):
    LOCALE_DIR = os.path.join(USER_DIR, 'locale')
else:
    LOCALE_DIR = None



class GSConnectShareExtension(GObject.GObject, Nautilus.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize Gettext translations"""

        GObject.Object.__init__(self)

        try:
            locale.setlocale(locale.LC_ALL, '')
            gettext.bindtextdomain('org.gnome.Shell.Extensions.GSConnect', LOCALE_DIR)
        except:
            pass

        self.devices = {}

        Gio.DBusObjectManagerClient.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
            'org.gnome.Shell.Extensions.GSConnect',
            '/org/gnome/Shell/Extensions/GSConnect',
            None,
            None,
            None,
            self._init_async,
            None)

    def _init_async(self, source_object, res, user_data):
        self.manager = source_object.new_for_bus_finish(res)

        for obj in self.manager.get_objects():
            for interface in obj.get_interfaces():
                self._on_interface_added(self.manager, obj, interface)

        self.manager.connect('interface-added', self._on_interface_added)
        self.manager.connect('object-removed', self._on_object_removed)

    def _on_interface_added(self, manager, obj, interface):
        if interface.props.g_interface_name == 'org.gnome.Shell.Extensions.GSConnect.Device':
            self.devices[interface.props.g_object_path] = (
                interface.get_cached_property('Name').unpack(),
                Gio.DBusActionGroup.get(
                    interface.get_connection(),
                    'org.gnome.Shell.Extensions.GSConnect',
                    interface.props.g_object_path))

    def _on_object_removed(self, manager, obj):
        del self.devices[obj.props.g_object_path]

    def send_files(self, menu, files, action_group):
        """Send *files* to *device_id*"""

        for file in files:
            variant = GLib.Variant('(sb)', (file.get_uri(), False))
            action_group.activate_action('shareFile', variant)

    def get_file_items(self, window, files):
        """Return a list of select files to be sent"""

        # Enumerate capable devices
        devices = []

        for name, actions in self.devices.values():
            if actions.get_action_enabled('shareFile'):
                devices.append([name, actions])

        # No capable devices; don't show menu entry
        if not devices:
            return

        # Only accept regular files
        for uri in files:
            if uri.get_uri_scheme() != 'file' or uri.is_directory():
                return

        # Context Menu Item
        menu = Nautilus.MenuItem(
            name='GSConnectShareExtension::Devices',
            label=_('Send To Mobile Device'),
            icon='smartphone-symbolic'
        )

        # Context Menu
        submenu = Nautilus.Menu()
        menu.set_submenu(submenu)

        # Context Submenu Items
        for name, action_group in devices:
            item = Nautilus.MenuItem(
                name='GSConnectShareExtension::Device' + name,
                label=name,
                icon='smartphone-symbolic'
            )

            item.connect('activate', self.send_files, files, action_group)

            submenu.append_item(item)

        return menu,

