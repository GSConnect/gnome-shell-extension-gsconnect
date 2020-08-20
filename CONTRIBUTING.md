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

## Questions

For general discussion, there is an IRC/Matrix channel for GSConnect:

* Matrix: https://matrix.to/#/#_gimpnet_#gsconnect:matrix.org
* IRC: irc://irc.gimp.org/#gsconnect

If that's not convenient, discussion can happen in the comments to your
[Pull Request][pr] or you can open a [New Issue][issue] for more public
discussion and mark the Pull Request as a fix for it.

[design]: https://wiki.gnome.org/Projects/GnomeShell/Design/Principles
[hig]: https://developer.gnome.org/hig/stable/
[translating]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Translating
[packaging]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Packaging
[theming]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Theming
[issue]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues
[pr]: https://github.com/GNOME/gnome-shell/pulls
[gjs]: https://gitlab.gnome.org/GNOME/gjs/wikis/home

