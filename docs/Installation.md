---
title: Installation
---
### Contents

* **[Standard](#standard)**
* **[Install from Zip](#install-from-zip)**
* **[Install from Git](#install-from-git)**
* **[Dependencies](#dependencies)**

## Standard

1. **Install GSConnect from the [GNOME Shell Extensions website][ego-install]**

   ![ego][ego]

2. **Install [KDE Connect][kdeconnect] Android from [Google Play][google-play] or [F-droid][f-droid]**

   [<img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png' height='80'/>][google-play][<img src="https://f-droid.org/badge/get-it-on.png"
      alt="Get it on F-Droid"
      height="80">][f-droid]

3. **Open the App and tap <kbd>**⊕ Pair new device**</kbd> in the sidebar**

   <img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/kdeconnect-android/main-sidebar.png" width="300" />

4. **Swipe down to refresh and you should see your device**

   ![GSConnect & KDE Connect Android][gsconnect-android]

5. **Tap on <kbd>**GSConnect**</kbd> and then tap <kbd>**REQUEST PAIRING**</kbd>**

   <img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/kdeconnect-android/device-request-pairing.png" width="300" />

6. **Complete the pairing process by clicking <kbd>**Accept**</kbd> in the notification**

   ![Pair Request][pair-notification]

If you are having trouble connecting a device, please see the **[Help](Help)** page before opening a [New Issue](../issues/new).

## Install from Zip

1. **Download the [Latest Release][latest-release]**

   The GNOME Extensions website reviews all submissions and often distributes an older version.

2. **Extract the extension**

   ```sh
   mkdir -p ~/.local/share/gnome-shell/extensions
   rm -rf ~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io
   unzip -o gsconnect.andyholmes.github.io.zip -d ~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io
   ```

3. **Restart Gnome Shell**

   * **X11/Xorg:** <kbd>Alt</kbd> + <kbd>F2</kbd> then `restart`
   * **Wayland:** Log out and log in.

## Install from Git

You can build or install from git with [Meson](http://mesonbuild.com):

```sh
git clone https://github.com/andyholmes/gnome-shell-extension-gsconnect.git
meson gnome-shell-extension-gsconnect/ _build
mkdir -p ~/.local/share/gnome-shell/extensions
ninja -C _build install-zip
```
It can be built for system installation using the default `install` target:

```sh
meson --prefix /usr --libdir lib/ gnome-shell-extension-gsconnect/ _build
ninja -C _build install
```

Please see the [Packaging](Packaging) page if you are interested in packaging GSConnect for a distribution.

## Dependencies

**This extension does not depend on the KDE Connect desktop application**

As of **v13** GSConnect requires `gnome-shell >= 3.28`. Some features require additional software that can be installed using PackageKit, if supported.

* **Remote Filesystems** require [sshfs][sshfs] to be mounted and accessed. This is required by the *SFTP* plugin.

  | Distribution  | Required Packages |
  |---------------|-------------------|
  | Arch          | `sshfs`           |
  | Debian/Ubuntu | `sshfs`           |
  | Fedora        | `fuse-sshfs`      |
  | Gentoo        | `sshfs`           |
  | openSUSE      | `sshfs`           |

* **Sound Effects** require [libcanberra][libcanberra] and [GSound][gsound] can be used if available. This is required by the *Find My Phone* plugin.

  | Distribution  | Required Packages        | Optional Packages            |
  |---------------|--------------------------|------------------------------|
  | Arch          | `libcanberra`            | `gsound`                     |
  | Debian/Ubuntu | `gnome-session-canberra` | `gir1.2-gsound-1.0`          |
  | Fedora        | `libcanberra-gtk3`       | `gsound`                     |
  | Gentoo        | `libcanberra`            | `gsound`                     |
  | openSUSE      | `canberra-gtk-play`      | `typelib-1_0-GSound`         |

* **Extended Keyboard Support** _(not yet in released version)_ requires [Caribou][caribou] for modifiers (<kbd>Alt</kbd>, <kbd>Ctrl</kbd>, <kbd>Super</kbd>, etc) and Unicode. This is used by the *Mousepad* plugin when simulating local keyboard events.

  | Distribution  | Required Packages        |
  |---------------|--------------------------|
  | Arch          | `caribou`                |
  | Debian/Ubuntu | `gir1.2-caribou-1.0`     |
  | Fedora        | `caribou`                |
  | Gentoo        | `caribou`                |
  | openSUSE      | `typelib-1_0-Caribou-1_0`|

* **Desktop Contacts** requires [Folks][folks] to access desktop contacts (Gnome Online Accounts, Evolution, local address book). This can be used by the *Telephony* and *Notifications* plugins.

  | Distribution  | Required Packages                                      |
  |---------------|--------------------------------------------------------|
  | Arch          | `folks`                                                |
  | Debian/Ubuntu | `libglib2.0-dev`, `gir1.2-folks-0.6`, `libfolks-eds25` |
  | Fedora        | `folks`                                                |
  | Gentoo        | `folks`                                                |
  | openSUSE      | `typelib-1_0-FolksEds-0_6`                             |

* **Files Integration** requires [Nautilus Extensions][nautilus] to modify the context menu. This can be used to share files from Nautilus.

  | Distribution  | Required Packages                                      |
  |---------------|--------------------------------------------------------|
  | Arch          | `python-nautilus`                                      |
  | Debian/Ubuntu | `python-nautilus`, `gir1.2-nautilus-3.0`               |
  | Fedora        | `python2-nautilus`, `nautilus-extensions`              |
  | Gentoo        | `nautilus-python`                                      |
  | openSUSE      | `python-nautilus`                                      |


[ego-install]: https://extensions.gnome.org/extension/1319/gsconnect/
[ego]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/ego-service-icon.png
[gsconnect-android]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/gsconnect-android.png
[pair-notification]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/gsconnect/pair-notification.png

[kdeconnect]: https://community.kde.org/KDEConnect
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/

[pair-new-device]: ../extra/kdeconnect-android/pair-new-device.png

[latest-release]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/releases/latest

[folks]: https://wiki.gnome.org/Projects/Folks
[nautilus]: https://wiki.gnome.org/Projects/NautilusPython
[sshfs]: https://github.com/libfuse/sshfs
[libcanberra]: http://0pointer.de/lennart/projects/libcanberra/
[gsound]: https://wiki.gnome.org/Projects/GSound
[caribou]: https://wiki.gnome.org/Projects/Caribou
