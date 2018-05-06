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

USER_DIR = os.path.join(GLib.get_user_data_dir(), 'gnome-shell/extensions/gsconnect@andyholmes.github.io')

if os.path.exists(USER_DIR):
    LOCALE_DIR = os.path.join(USER_DIR, 'locale')
    SCHEMA_DIR = os.path.join(USER_DIR, 'schemas')
else:
    LOCALE_DIR = ''
    SCHEMA_DIR = ''



class GSConnectShareExtension(GObject.GObject, Nautilus.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize Gettext translations and GSettings"""

        GObject.Object.__init__(self)

        try:
            locale.setlocale(locale.LC_ALL, '')
            gettext.bindtextdomain('org.gnome.Shell.Extensions.GSConnect', LOCALE_DIR)
        except:
            pass

        schema = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR,
                                                             Gio.SettingsSchemaSource.get_default(),
                                                             False)
        self.settings = Gio.Settings(settings_schema=schema.lookup('org.gnome.Shell.Extensions.GSConnect', True))

        self.dbus = Gio.DBusProxy.new_for_bus_sync(
			Gio.BusType.SESSION,
			Gio.DBusProxyFlags.NONE,
			None,
			'org.gnome.Shell.Extensions.GSConnect',
			'/org/gnome/Shell/Extensions/GSConnect',
			'org.gnome.Shell.Extensions.GSConnect',
			None)

    def send_files(self, menu, files, devicePath):
        """Send *files* to *device_id*"""

        device_proxy = Gio.DBusProxy.new_for_bus_sync(
			Gio.BusType.SESSION,
			Gio.DBusProxyFlags.NONE,
			None,
			'org.gnome.Shell.Extensions.GSConnect',
			devicePath,
			'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
			None)

        for file in files:
            variant = GLib.Variant('(s)', (file.get_uri(),))
            device_proxy.call_sync('ShareFile', variant, 0, -1, None)

    def get_file_items(self, window, files):
        """Return a list of select files to be sent"""

        if not self.settings.get_boolean('nautilus-integration'):
            return

        # Try to get devices
        try:
            devices = self.dbus.call_sync('GetShareable', None, 0, -1, None)
            devices = devices.unpack()[0]
        except Exception as e:
            raise Exception('Error while getting reachable devices: ')

        # No devices, don't show menu entry
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
        for devicePath, deviceName in devices:
            item = Nautilus.MenuItem(
                name='GSConnectShareExtension::Device' + deviceName,
                label=deviceName,
                icon='smartphone-symbolic'
            )

            item.connect('activate', self.send_files, files, devicePath)

            submenu.append_item(item)

        return menu,

