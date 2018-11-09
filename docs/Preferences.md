---
title: Preferences
---
![Extension Preferences][preferences-shell]

## Shell
### Show Indicators

If enabled, each device will be given an indicator with an icon that represents the device type (smartphone, tablet or laptop) with an indication of its current state (this may be a colour or an emblem, depending on the icon theme). Controls for the device will be in popup menu available by clicking on the icon.

![Device Indicator Menu][device-indicator-menu]

If disabled, the same menu found in the indicator popup will instead appear in the *Mobile Devices* submenu found in the Gnome Shell User Menu. This is the menu on the far right of the panel where Session Controls, Wi-Fi, Location and other services are found.

![Device User Menu Entry][device-user-menu-menu]

### Show Offline

If disabled, devices will be hidden in Gnome Shell when they are disconnected, but will still be visible and available for configuration in the [Devices](Devices) page of the extension preferences.

### Show Unpaired

If disabled, devices will be hidden in Gnome Shell when they are unpaired, but will still be available for pairing in the [Devices](Devices) page of the extension preferences as long as they are connected.

### Show Battery Icon

If enabled, a traditional battery icon with percentage will be shown in the Device Menu.

![Device User Menu Entry][device-menu-battery-icon]

## Files Integration

If supported, a list of devices that can receive files will be added to the Files (Nautilus) context menu. Clicking on a device will send the currently selected files to that device.

![Files Integration][files-integration]

## Web Browser Integration

The [Chrome/Chromium Extension][chrome] and [Firefox Add-on][firefox] allow you to share links either directly in your device's browser or share with a contact by SMS.

![Web Browser Integration][webextension-screenshot]


[preferences-shell]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/gsconnect/preferences-shell.png
[device-indicator-menu]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/device-indicator-menu.png
[device-user-menu-menu]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/device-user-menu-menu.png
[device-menu-battery-icon]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/device-menu-battery-icon.png

[files-integration]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/nautilus-integration.png

[chrome]: https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec
[firefox]: https://addons.mozilla.org/en-US/firefox/addon/gsconnect/
[webextension-screenshot]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/extra/webextension-screenshot.png
