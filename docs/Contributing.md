---
title: Contributing
---
Thank you for considering contributing to this project. It means that you not
only find it useful, but that you think there's something that could be done to
make it more useful, or useful to more people.

The goal is to create an implementation of KDE Connect that integrates with the
Gnome desktop more than is appropriate for the original implementation, not just
duplicating its functionality. The [Gnome Shell Design Principles][design] and
[Gnome Human Interface Guidelines][hig] are followed whenever appropriate.

## Code of Conduct

Stay on topic. This applies to what you think, say, and do.

## Overview

This document is mostly about code contributions. There are pages in the Wiki
for [Translating][translating], [Theming][theming] and [Packaging][packaging].
You can open a [New Issue][issue] or [Pull Request][pr] for anything you like
and it will be reviewed.

### Code Guidelines

* Code SHOULD be written in [GJS][gjs] if at all possible

  Almost all of the Gnome API is available through introspection, however in the
  few cases it is not Python is acceptable.

* Code MUST NOT be written in a pre-compiled language

  The extension is distributed as-is to users via the GNOME Shell Extensions
  website and must not include architecture dependant code or binaries.

* Code MUST run anywhere Gnome Shell runs

  It is acceptable and sometimes necessary to use resources that may be specific
  to Linux, but fallbacks must be available for other systems like BSD. Virtual
  machines may be supported, but not at any expense to real systems.

* Code MUST NOT break compatibility with the KDE Connect project

  Under no circumstances may code break protocol compatibility or introduce new
  protocol features. Any protocol related discussion must happen directly with
  the KDE Connect team and changes or additions are subject to their approval.

### Code Style

JavaScript doesn't follow a formal style guide; the existing code is the guide.
Prefer ES6 syntax, `if () {` long-form code blocks `}`, camelCase naming,
`_private` and `__implementation` prefixes, 4-space indents and 80 character lines.
Python can either imitate the same style or use PEP-8.

### A Note About Template Strings

JavaScript template literals are not handled well by gettext, like in the case
`` `<b>Breaks!</b>` ``. Once you have committed your changes and are about to
push, run the meson target for the POT file to confirm it still works:

```console
$ ninja -C _build/ org.gnome.Shell.Extensions.GSConnect-pot
ninja: Entering directory `_build/'
[0/1] Running external command org.gnome.Shell.Extensions.GSConnect-pot.
src/extension.js:396: warning: RegExp literal terminated too early
```

Note that error messages might be incorrect and the line number earlier in the
file than is claimed. Adjust the code to use concatentation with `+` or `join()`
until it succeeds. Then discard the POT file changes and amend your commit:

```sh
git checkout -- po/org.gnome.Shell.Extensions.GSConnect.pot
git commit --amend --no-edit
```

## Questions

For general discussion, there is an IRC/Matrix channel available:

* **Matrix:** https://matrix.to/#/#_gimpnet_#gsconnect:matrix.org
* **IRC:** <a href="irc://irc.gimp.org/#gsconnect">irc://irc.gimp.org/#gsconnect</a>

If that's not convenient, discussion can happen in the comments to your
[Pull Request][pr] or you can open a [New Issue][issue] for more public
discussion and mark the Pull Request as a fix for it.

[design]: https://wiki.gnome.org/Projects/GnomeShell/Design/Principles
[hig]: https://developer.gnome.org/hig/stable/
[translating]: Translating
[packaging]: Packaging
[theming]: Theming
[issue]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues
[pr]: https://github.com/GNOME/gnome-shell/pulls
[gjs]: https://gitlab.gnome.org/GNOME/gjs/wikis/home
