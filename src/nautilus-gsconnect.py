"""
nautilus-gsconnect.py - A Nautilus extension for sending files via GSConnect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script 'kdeconnect-send-nautilus.py':

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

import gi
gi.require_version('Nautilus', '3.0')
from gi.repository import Nautilus, Gio, GLib, GObject

import gettext
import locale
import os.path
import subprocess

_ = gettext.gettext

LOCALE_DIR = os.path.expanduser("~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io/locale")
CLI_PATH = os.path.expanduser("~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io/share.js")


class GSConnectShareExtension(GObject.GObject, Nautilus.MenuProvider):
    """A context menu for sending files via GSConnect."""

    def __init__(self):
        """Initialize translations"""
        
        try:
            locale.setlocale(locale.LC_ALL, '')
            gettext.bindtextdomain('gsconnect', LOCALE_DIR)
            gettext.textdomain('gsconnect')
        except:
            pass
        
        self.dbus = Gio.DBusProxy.new_for_bus_sync(
			Gio.BusType.SESSION,
			Gio.DBusProxyFlags.NONE,
			None,
			'org.gnome.shell.extensions.gsconnect.daemon',
			'/org/gnome/shell/extensions/gsconnect/daemon',
			'org.gnome.shell.extensions.gsconnect.daemon',
			None)

    def get_reachable_devices(self):
        """Return a list of reachable, trusted devices"""
        
        print self.dbus.call_sync("getShareable", None, 0, -1, None)
        
        devices = self.dbus.call_sync("getShareable", None, 0, -1, None)
        
#        for device in filter(None, out.decode('utf-8').split("\n")):
#            device_name, device_id = device.split(': ')
#            devices.append({ 'name': device_name, 'id': device_id })

    def send_files(self, menu, files, device):
        """Send *files* to *device_id*"""
        
        dev_dbus = Gio.DBusProxy.new_for_bus_sync(
			Gio.BusType.SESSION,
			Gio.DBusProxyFlags.NONE,
			None,
			'org.gnome.shell.extensions.gsconnect.daemon',
			'/org/gnome/shell/extensions/gsconnect/device/' + device.values()[0],
			'org.gnome.shell.extensions.gsconnect.share',
			None)
        
        for file in files:
            variant = GLib.Variant("(s)", (file.get_uri(),))
            dev_dbus.call_sync("shareUri", variant, 0, -1, None)

    def get_file_items(self, window, files):
        """Return a list of select files to be sent"""
        
        # Try to get devices
        try:
            devices = self.dbus.call_sync("getShareable", None, 0, -1, None)
        except Exception as e:
            raise Exception('Error while getting reachable devices')

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
        for device in devices:
            item = Nautilus.MenuItem(
                name='GSConnectShareExtension::Device' + device.values()[0],
                label=device.keys()[0],
                icon='smartphone-symbolic'
            )
            
            item.connect('activate', self.send_files, files, device)
            
            submenu.append_item(item)

        return menu,
        
