# KDE Connect implementation with Gnome Shell integration

![Extension Screenshot][screenshot]

## Overview

This extension is a complete [KDE Connect][kdeconnect] protocol implementation
written in [GJS][gjs] that integrates with Gnome Shell and Nautilus.

To connect an Android device, install the KDE Connect Android app from the
[Google Play Store][google-play] or [F-Droid][f-droid].

See the [Wiki][wiki] for more information.


### Installation

This extension has not been reviewed on the official extensions website, but is
considered a stable replacement for KDE Connect on Gnome Shell.

Stable releases are available for download on the [releases page][releases].
The Wiki contains instructions for [building from Git][wiki-git] and full list
of [dependencies][wiki-depends].

    
### Credits

Code from [python-folks][python-folks] by [@hugosenari][hugosenari] was adapted
to provide libfolks.

Code from [application-overview-tooltip][tooltips] by
[@RaphaelRochet][RaphaelRochet] was adapted to provide tooltips.

Icons from the [Numix][numix] project and Google's [Material Design][material]
project are included to provide fallbacks and supplement icon themes.


### Related Projects

* [KDE Connect][kdeconnect] - The original and reference implementation
* [MConnect][mconnect] - A KDE Connect protocol implementation in Vala/C
* [GConnect][gconnect] - Another Vala/C implementation
* [indicator-kdeconnect][kindicator] - A KDE Connect indicator for Gtk desktops

### Thanks

[@albertvaka][albertvaka] and friends for creating KDE Connect, and help on the
mailing list.

[@ptomato][ptomato], [@pwithnall][pwithnall] and [@nielsdg][nielsdg] for help
on Stackoverflow and the Gnome Bugzilla.

Joe Sneddon of [OMG! Ubuntu][omgubuntu] for his interest, support and articles.


[screenshot]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/screenshot.png
[gjs]: https://wiki.gnome.org/Projects/Gjs
[releases]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/releases
[wiki]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki
[wiki-git]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#building-from-git
[wiki-depends]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#dependencies

[kdeconnect]: https://community.kde.org/KDEConnect
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/
[mconnect]: https://github.com/bboozzoo/mconnect
[gconnect]: https://github.com/getzze/gconnect
[kindicator]: https://github.com/Bajoja/indicator-kdeconnect

[albertvaka]: https://github.com/albertvaka
[hugosenari]: https://github.com/hugosenari
[python-folks]: https://github.com/hugosenari/folks
[RaphaelRochet]: https://github.com/RaphaelRochet
[tooltips]: https://github.com/RaphaelRochet/applications-overview-tooltip
[numix]: https://numixproject.org/
[material]: https://material.io/

[ptomato]: https://github.com/ptomato
[pwithnall]: https://github.com/pwithnall
[nielsdg]: https://github.com/nielsdg
[omgubuntu]: http://www.omgubuntu.co.uk/

