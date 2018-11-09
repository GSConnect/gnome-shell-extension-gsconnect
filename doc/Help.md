---
title: Help
---
* [Connecting an Android Device](#connecting-an-android-device)
* [Other problems](#other-problems)
  * [Remote filesystems open in the wrong application](#remote-filesystems-open-in-the-wrong-application)
* [File Locations](#file-locations)
  * [Where are the cached files stored?](#where-are-cached-files-stored)
  * [Where are the settings stored?](#where-are-settings-stored)
  * [How can I reset all settings?](#how-can-i-reset-all-settings)
* [Detected Problems](#detected-problems)
  * [Network Error](#LanError)
  * [Proxy Error](#ProxyError)
  * [PulseAudio Error](#GvcError)
  * [Incompatible SSH Library](#SSHSignatureError)
  * [Wayland Not Supported](#WaylandNotSupported)


## Connecting an Android device

1. **Install [KDE Connect][kdeconnect] Android from [Google Play][google-play] or [F-droid][f-droid]**

   [<img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png' height='80'/>][google-play][<img src="https://f-droid.org/badge/get-it-on.png"
      alt="Get it on F-Droid"
      height="80">][f-droid]

2. **Open the Android App and GSConnect Preferences**

    ![GSConnect & KDE Connect Android][gsconnect-android]

3. **Click <kbd>Refresh</kbd> in GSConnect preferences or the Android app**

   ![Service Preferences][preferences-refresh]

4. **Connect to GSConnect by IP**

   <img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/kdeconnect-android/add-devices-by-ip.png" width="640">

5. **Connect to Android by IP**

    ![Connect to...][preferences-connect-to]

6. **Check your Firewall, Proxy, Router and VPN**

   Open ports **1716-1764** for **TCP and UDP** and **allow broadcasts**.

7. **Open a [New Issue][new-issue]**

## Other Problems
### Files and directories open in the wrong application

Sometimes the wrong application is registered as the default handler for the `inode/directory` mime-type. You can set the correct handler by running the following command in a terminal as a regular user:

    $ xdg-mime default org.gnome.Nautilus.desktop inode/directory

`org.gnome.Nautilus.desktop` can be replaced with another file manager or application if desired.

## File Locations

### Where are the cached files stored?

Cached files are stored in the user cache directory under gsconnect. Each device has it's own sub-directory, while the remaining files and folders are cached by the service:

    ~/.cache/gsconnect/<device-id>/battery.json
    ~/.cache/gsconnect/contacts.json
    ~/.cache/gsconnect/7b2c8d552e9043232d1466e28af55367

### Where are the settings stored?

Settings are stored in dconf using GSettings. You can access the settings using [dconf-editor][dconf-editor] at the path:

    /org/gnome/shell/extensions/gsconnect/

### How can I reset all settings?

There is a button in the **Advanced** page of the device preferences for completely removing a device. You can completely remove all GSConnect settings and files from the command-line:

    dconf reset -f /org/gnome/shell/extensions/gsconnect/
    rm -rf ~/.cache/gsconnect
    rm -rf ~/.config/gsconnect

## Detected Problems

> **These problems are automatically detected. Please do not edit this section.**

<h3 id="LanError">Network Error</h3>

GSConnect requires ports **1716-1764** for **TCP and UDP**. This error means another program is using those ports, usually KDE Connect (`kdeconnectd`).

1. **Check if KDE Connect is running**

    If you have recently uninstalled KDE Connect the server may still be running.

    ```sh
    $ pidof kdeconnectd
    18839
    $ lsof -i UDP:1716
    COMMAND     PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
    kdeconnec 18839 andrew   19u  IPv6 2394913      0t0  UDP *:1716
    ```

2. **Stop KDE Connect (`kdeconnectd`) if it is running**

   You should also uninstall KDE Connect, since it will start each time you log into your session.

    ```sh
    $ killall -9 kdeconnectd
    ```

3. **Restart GSConnect in the Service Preferences**

    ![Restart the service][preferences-service-restart]


4. **Open a New Issue**

   If you are still getting this error notification, please open a [New Issue][new-issue].

<h3 id="ProxyError">Proxy Error</h3>

This error means a connection failed to connect or authenticate with the network proxy. No further help yet, sorry.

<h3 id="GvcError">PulseAudio Error</h3>

GSConnect uses the PulseAudio bindings shipped with Gnome Shell for volume control features. This error means that GSConnect failed to find the required typelib (`Gvc-1.0.typelib`).

If you installed GSConnect from a distribution package, please file a bug with the package maintainer and reference the [Packaging](Packaging) page.

If you installed GSConnect from https://extensions.gnome.org or another user install method, please open a [New Issue][new-issue] including your distribution and output of `locate Gvc-1.0.typelib`.

<h3 id="SSHSignatureError">Incompatible SSH Library</h3>

Some newer versions of OpenSSH seem to be incompatible with the Android app, which breaks remote file system (SFTP) support. The issue is known by developers and a fix is in progress. Please be patient.

<h3 id="WaylandNotSupported">Wayland Not Supported</h3>

Some features require functionality not yet available in Gnome on Wayland. Currently **Remote Input features are disabled** (see [Accessibility + Wayland](https://wiki.gnome.org/Accessibility/Wayland) for more information). Clipboard features are enabled using a workaround, but **may be disabled in future**.


[add-devices-by-ip]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/kdeconnect-android/add-devices-by-ip.png
[preferences-connect-to]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/preferences-connect-to.png
[preferences-refresh]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/preferences-refresh.png
[preferences-service]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/preferences-service.png
[preferences-service-restart]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/preferences-service-restart.png
[preferences-shell]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/preferences-shell.png
[gsconnect-android]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/gsconnect-android.png

[new-issue]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues/new
[design]: https://wiki.gnome.org/Projects/GnomeShell/Design/Principles
[hig]: https://developer.gnome.org/hig/stable/
[dconf-editor]: https://wiki.gnome.org/Projects/dconf#GUI_editor
[kdeconnect]: https://community.kde.org/KDEConnect
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/
