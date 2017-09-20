"""
nautilus-send-mconnect.py - A Nautilus extension for sending files via
                            MConnect/KDE Connect.

A great deal of credit and appreciation is owed to the indicator-kdeconnect
developers for the sister Python script 'kdeconnect-send-nautilus.py':

https://github.com/Bajoja/indicator-kdeconnect/blob/master/data/extensions/kdeconnect-send-nautilus.py
"""

import gi
gi.require_version('Nautilus', '3.0')
from gi.repository import Nautilus, GObject

import gettext
import locale
import os.path
import subprocess

_ = gettext.gettext

LOCALE_DIR = os.path.expanduser("~/.local/share/gnome-shell/extensions/mconnect@andyholmes.github.io/locale")
CLI_PATH = os.path.expanduser("~/.local/share/gnome-shell/extensions/mconnect@andyholmes.github.io/share.js")


class MConnectShareExtension(GObject.GObject, Nautilus.MenuProvider):
    """A context menu for sending files via the MConnect/KDE Connect."""

    def __init__(self):
        """Initialize translations"""
        
        try:
            locale.setlocale(locale.LC_ALL, '')
            gettext.bindtextdomain(
                'gnome-shell-extension-mconnect',
                LOCALE_DIR
            )
            gettext.textdomain('gnome-shell-extension-mconnect')
        except:
            pass

    def get_reachable_devices(self):
        """Return a list of reachable, trusted devices"""
        
        args = ['gjs', CLI_PATH, '--list-available']
        out = subprocess.Popen(args, stdout=subprocess.PIPE).stdout.read()
        
        devices = []
        
        for device in filter(None, out.decode('utf-8').split("\n")):
            device_name, device_id = device.split(': ')
            devices.append({ 'name': device_name, 'id': device_id })

        return devices

    def send_files(self, menu, files, device):
        """Send *files* to *device_id*"""
        
        args = ['gjs', CLI_PATH, '--device=' + device['id']]
        
        for file in files:
            args.append('--share=' + file.get_uri())
        
        subprocess.Popen(args)

    def get_file_items(self, window, files):
        """Return a list of select files to be sent"""
        
        # Try to get devices
        try:
            devices = self.get_reachable_devices()
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
            name='MConnectShareExtension::Devices',
            label=_('Send To Mobile Device'),
            icon='smartphone-symbolic'
        )

        # Context Menu
        submenu = Nautilus.Menu()
        menu.set_submenu(submenu)

        # Context Submenu Items
        for device in devices:
            item = Nautilus.MenuItem(
                name='MConnectShareExtension::Device' + device['id'],
                label=device['name'],
                icon='smartphone-symbolic'
            )
            
            item.connect('activate', self.send_files, files, device)
            
            submenu.append_item(item)

        return menu,
        
