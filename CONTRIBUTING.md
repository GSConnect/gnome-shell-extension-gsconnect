# Contributing

Thank you for considering contributing to this project. It means that you not
only find it useful, but that you think there's something that could be done to
make it more useful, or useful to more people. Suggestions are welcome, but not
all requests can or will be implemented.

The vision of this project is to be pure Gnome, targetting recent versions of
Gnome Shell (currently 3.24+), taking advantage of stock resources and
generally conforming to the [Gnome Shell Design Principles][design] and
[Gnome Human Interface Guidelines][hig].

With regard to the KDE Connect protocol, the goal is to be compatible with
upstream KDE Connect, especially the current version of the Android app.

All code *should* be written in [GJS][gjs] if at all possible and *must not* be
written in compiled languages that are architecture dependent. Essentially, it
should be ready as soon as it's unpacked from the extension ZIP file.

The best way to get in touch is by [opening a new issue][issue].

[design]: https://wiki.gnome.org/Projects/GnomeShell/Design/Principles
[hig]: https://developer.gnome.org/hig/stable/
[issue]: https://github.com/andyholmes/gnome-shell-extension-mconnect/issues/new
[gjs]: https://wiki.gnome.org/Projects/Gjs
