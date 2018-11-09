--
title: Packaging
---
> **Note to Users**
>
> This documentation is meant for distribution packagers. If you encounter a packaging bug with GSConnect, you should file a *downstream* bug report with the distribution or package maintainer.

GSConnect uses a complete meson build that can produce a user Zip or system package.

### PackageKit

As of v13 GSConnect includes support for installing dependencies with PackageKit. [`service/ui/packagekit.js`][packagekit-js] contains a `PackageGroup` dictionary containing the possible package names for each distribution to meet a feature's dependencies. This makes it easy for your users to install dependencies, even when they get GSConnect from [extensions.gnome.org](https://extensions.gnome.org/).

You may submit a [Pull Request](../pulls) to add package names for your distribution and there are tables in the [Installation](Installation#dependencies) page that you can add them to. Please don't add package names that are not required for a feature to function even if they seem closely related.

### Dependencies

The only true dependency of GSConnect is `gnome-shell >= 3.28`, so packagers can decide what they consider required or optional dependencies. Each feature below lists the precise shared objects (`.so`), typelibs (`.typelib`) or binaries required, and briefly describes what plugin or functionality requires it.

* **Contacts Integration (libfolks)**

  **REQUIRES:** `libgobject-2.0.so.0`, `libfolks-eds.so.25`, `Folks-0.6.typelib`

  GSConnect supports integrating desktop contacts using libfolks, which aggregates contacts from Gnome Online Accounts, Evolution and more.

  If libfolks is not supported an address book cached from received data will be used.

* **Files Integration (nautilus-python)**

  **REQUIRES:** `Nautilus-3.0.typelib`, `libnautilus-python.so`

  GSConnect includes a Nautilus extension written using the Python bindings allowing files to be sent from the context menu of selected items.

  See the `meson` notes for `--nautilus` below for more information.

* **Sound Effects (libcanberra)**

  **REQUIRES:** `canberra-gtk-play`

  GSConnect plays sounds from the sound-theme-spec and most Gnome Shell users will have libcanberra and `canberra-gtk-play` installed as a dependency of the desktop. GSConnect can also use the GSound API if available, but this is optional.

  The **Find My Phone** plugin loops a sound effect when receiving a location request.

* **Remote Filesystem (libfuse-sshfs)**

  **REQUIRES:** `sshfs`

  Due to limitations with Android remote file systems can not be mounted using GVfs, Nautilus or any other higher level interface (See [Issue #84](../issues/83)). The `sshfs` binary is used by KDE Connect and GSConnect in nearly identical ways.

  The **SFTP** plugin uses `sshfs` to access remote filesystems (currently Android only).

### Notes on `meson` Options

If you need additional build options to package GSConnect for your distribution, consider opening a [New Issue](../issues/new) describing your requirements before maintaining a downstream patch. If the required changes don't break compatibility for another packager, they will probably be approved.

* **`-Dgnome_shell_libdir=PATH`**

  Default is `PREFIX/LIBDIR`, where `LIBDIR` is as defined by `--libdir`. If provided it will override `LIBDIR` when searching for `Gvc-1.0.typelib` so that the result is:

  ```sh
  GNOME_SHELL_LIBDIR/gnome-shell/Gvc-1.0.typelib
  ```

  When installed as a user extension *`PREFIX/LIBDIR`* is inferred from `gjs`'s GIRepository search path. When building as a system package, GSConnect will fallback to this behaviour if `GNOME_SHELL_LIBDIR/gnome-shell/Gvc-1.0.typelib` is not found at runtime.

* **`-Dgsettings_schemadir=PATH`**

  Default is `PREFIX/DATADIR/glib-2.0/schemas`. If provided it will override the path when compiling and loading the GSchema so that the result is:

  ```sh
  GSETTINGS_SCHEMADIR/gschemas.compiled
  ```

* **`-Dpost_install=false`**

  Default is `false`. If `true` the script `meson/post-install.sh` will be run at the end of the `install` target. Currently, this compiles the GSchemas in `GSETTINGS_SCHEMADIR` using `glib-compile-schemas`.

* **`-Dsession_bus_services_dir=PATH`**

  GSConnect uses DBus Activation so that the Shell extension can start the service at login and restart it if updated.

  When installed as a user extension the service file is installed to `XDG_DATA_HOME/dbus-1/services/` by the Shell extension when it is loaded (not enabled/disabled). When building as a system package the default is to check `pkg-config`, then fallback back to `PREFIX/DATADIR/dbus-1/services`.

* **`-Dfusermount_path=fusermount`**
* **`-Dopenssl_path=openssl`**
* **`-Dsshfs_path=sshfs`**

   When building as a system package, each option will override the default behaviour of searching `PATH` when spawning an external process. In other words, the default is the executable name (eg. `sshfs`), but may be overriden with an absolute path to the executable (eg. `/usr/bin/sshfs`).

* **`-Dnautilus=true`**

  Default is `true`. If `false` the file `nautilus-gsconnect.py` will not be installed.

  When installed as a user extension the Nautilus extension will be installed in `XDG_DATA_HOME/nautilus-python/extensions/` by the Shell extension when it is loaded (not enabled/disabled). When building as a system package it will be installed to `PREFIX/DATADIR/nautilus-python/extensions/`.

  Although there is currently no build target for producing a separate package for the Nautilus extension, if that's appropriate for your distribution you are welcome to do so. The Nautilus extension only requires access to the Session DBus and translations.

* **`-Dwebextension=true`**

  Default is `true`. If `false` the WebExtension manifests will not be installed, making it impossible for the Native Messaging Host to be started by the Chrome Extension or Firefox Add-On. Although there is currently no build target for producing a separate package for the manifests it is possible, although the WebExtension itself will always be distributed from the browser's extension or add-on website.

  When installed as a user extension the manifests are installed by the Shell extension when it is loaded (not enabled/disabled) in the following locations:

  ```sh
  XDG_CONFIG_HOME/google-chrome{,-beta,-unstable}/NativeMessagingHosts/
  XDG_CONFIG_HOME/chromium/NativeMessagingHosts/
  HOME/.mozilla/native-messaging-hosts/
  ```

  When building as a system package:

  ```sh
  SYSCONFDIR/opt/chrome/native-messaging-hosts/
  SYSCONFDIR/chromium/native-messaging-hosts/
  PREFIX/LIBDIR/mozilla/native-messaging-hosts/
  ```

* **`-Dchrome_nmhdir=PATH`**
* **`-Dchromium_nmhdir=PATH`**
* **`-Dmozilla_nmhdir=PATH`**

  When building as a system package, these three options override the install path for the native messaging hosts so that the destination is:

  ```sh
  CHROME_NMHDIR/org.gnome.shell.extensions.gsconnect.json
  CHROMIUM_NMHDIR/org.gnome.shell.extensions.gsconnect.json
  MOZILLA_NMHDIR/org.gnome.shell.extensions.gsconnect.json
  ```

[packagekit-js]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/src/service/ui/packagekit.js
