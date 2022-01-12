# Contributing

Thank you for considering contributing to this project. It means that you not
only find it useful, but that you think there's something that could be done to
make it more useful, or useful to more people.

The goal is to create an implementation of KDE Connect that integrates with the
GNOME desktop more than is appropriate for the original implementation.

## Code of Conduct

While taking part in this project, all that is required is to stay on topic.

Note that you are still bound by the Code of Conduct for whichever platform you
use to access the project repository.

## Overview

This document is mostly about code contributions. There are pages in the Wiki
for [Translating][translating], [Theming][theming] and [Packaging][packaging].
You can open a [New Issue][issue] or [Pull Request][pr] for anything you like
and it will be reviewed.

### Code Guidelines

* Code MUST be written in [GJS][gjs] if at all possible

  Obvious exceptions are code that help integrate with other programs, like the
  Nautilus extension.

* Code MUST run anywhere GNOME Shell runs

  It is acceptable and sometimes necessary to use resources that may be specific
  to Linux, but fallbacks must be available for other systems like BSD. Virtual
  machines may be supported, but not at any expense to real systems.

* Code MUST NOT break compatibility with the KDE Connect project

  Under no circumstances may code break protocol compatibility or introduce new
  protocol features. Any protocol related discussion must happen directly with
  the KDE Connect team and changes or additions are subject to their approval.

### Code Style

GSConnect ships with an ESLint file, which is run on all code by the CI and can
be run on code simply with `eslint src/`. When in doubt, copy the existing code
style.

## Developing

### Architecture

GSConnect is composed of three relatively distinct components:

* Service (`/service`)

  The service runs as a separate process in the background and does all the
  heavy lifting, including connecting and communicating with remote devices. It
  also exposes several DBus interfaces.
  
* Shell Extension (`extension.js`, `/shell`)

  The GNOME Shell extension controls starting and stopping the service, and
  consumes the DBus interfaces exposed by the service. It also helps GSConnect
  to integrate into GNOME Shell.
  
* Preferences (`gsconnect-preferences`, `/preferences`)

  Unlike most extensions, GSConnect has it's own process for configuring the
  service and devices, which also communicates with the service over DBus.
  
### Building and Installing

GSConnect uses a [`meson`][meson] build system which can accomodate system or
user installs. Typically, GSConnect should be developed and installed as a user
extension, while support for system installs exists primarily for distributions
that want to package GSConnect.

#### User Install

When installing as a user extension, GSConnect will try its best to detect
necessary paths and automatically install required files required for the
service to run. The example below will build a user extension ZIP, then install
it:

```sh
$ meson _build
$ ninja -C _build install-zip
```

Use the `make-zip` target instead to simple build a distributable ZIP, which
will be output as `_build/gsconnect@andyholmes.github.io.zip`:

```sh
$ meson _build
$ ninja -C _build make-zip
```

#### System Install

When installing as a system extension, the build must be configured to ensure
GSConnect can function properly when run (details in `meson_options.txt`). Below
is a typical example for Fedora:

```sh
$ meson --prefix=/usr \
        --libdir=lib/ \
        -Dgnome_shell_libdir=/usr/lib64/ \
        -Dfirewalld=true \
        -Dpost_install=true \
        _build
$ ninja -C _build install
```

### Typical Workflow

The typical workflow for developing GSConnect will mainly involve working on the
service. First build and install the extension:

```sh
$ meson _build
$ ninja -C _build install-zip
```
    
Next restart GNOME Shell and enable the extension. While developing you should
enable debugging output and watch the output with `journalctl`:

```sh
$ dconf write /org/gnome/shell/extensions/gsconnect/debug true
$ journalctl -f -o cat /usr/bin/gjs
```

After making changes to the service, you should run the `install-zip` target
again. The service will automatically restart and there is no need to restart
GNOME Shell unless you have made changes to the shell extension:

```sh
$ ninja -C _build install-zip
```

#### Preferences

When working on the Preferences application, you must close and reopen the
window after running the `install-zip` target. You can use `journalctl` to watch
the output or if it's more convenient simply run the application from the shell:

```sh
$ cd ~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io
$ ./gsconnect-preferences
```

#### Shell Extension

When developing the Shell extension, you must restart GNOME Shell after making
any changes. Note that the `debug()` function is not available in the Shell
extension and you should watch `gnome-shell` with `journalctl` instead of GJS:

```sh
$ journalctl -f -o cat /usr/bin/gnome-shell
```

## Questions

For general discussion, there is an IRC/Matrix channel for GSConnect:

* Matrix: https://matrix.to/#/#_gimpnet_#gsconnect:matrix.org
* IRC: irc://irc.gimp.org/#gsconnect

If that's not convenient, discussion can happen in the comments to your
[Pull Request][pr] or you can open a [New Issue][issue] for more public
discussion and mark the Pull Request as a fix for it.

[design]: https://wiki.gnome.org/Projects/GnomeShell/Design/Principles
[hig]: https://developer.gnome.org/hig/stable/
[translating]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Translating
[packaging]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Packaging
[theming]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Theming
[issue]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues
[pr]: https://github.com/GNOME/gnome-shell/pulls
[gjs]: https://gitlab.gnome.org/GNOME/gjs/wikis/home

[meson]: https://mesonbuild.com/

