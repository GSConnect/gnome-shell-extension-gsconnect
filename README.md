# KDE Connect protocol implementation and integration for Gnome Shell

## Overview

This extension is a [KDE Connect][kde-connect] protocol implementation written
in (almost) pure [GJS][gjs] that integrates with Gnome Shell and Nautilus.

In order to communicate with an Android device, you must first install the KDE
Connect Android app, either from the [Google Play Store][google-play] or
[F-Droid][f-droid].


### Installation

The extension is currently in a **beta** stage of development. There are a few
*known* non-critical bugs, features are still subject to drastic change and
there are no translations and sparse instructions. In particular, the extension
is known to clash with running instances of KDE Connect and possibly MConnect.

Pre-releases can be downloaded from the [releases page][releases].

**You have been warned**

    
## Credits and Acknowledgements

[@albertvaka][albertvaka] and friends for creating KDE Connect, and
[@bboozzoo][bboozzoo] for developing MConnect based on their protocol.

[@Bajoja][Bajoja] and the [indicator-kdeconnect][kindicator] developers, for
advice and code I frequently reference.

[@hugosenari][hugosenari] for his Python shim for libgee, making support for
Folks possible and who graciously donated his time helping to make it work.

[@RaphaelRochet][RaphaelRochet] for [application-overview-tooltip][tooltips]
that was adapted to provide tooltips.

The [Numix][numix] project and Google's [Material Design][material] project,
some of whose icons are included in this extension.


### Special Mention

[@ptomato][ptomato], [@pwithnall][pwithnall] and [@nielsdg][nielsdg] for
helping me out and tolerating my harassment on Stackoverflow and the Gnome
Bugzilla.

[Joey Sneddon][d0od88], for his tireless KDE Connect evangelism.

The screenshot of the extension features the [Vimix Dark Laptop][vimix] Gtk &
Gnome Shell theme with the [Numix Circle][numix] icon theme.

[screenshot]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-mconnect/master/extra/screenshot.png
[kde-connect]: https://community.kde.org/KDEConnect
[gjs]: https://wiki.gnome.org/Projects/Gjs
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/
[mconnect]: https://github.com/bboozzoo/mconnect
[kindicator]: https://github.com/Bajoja/indicator-kdeconnect
[releases]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/releases
[albertvaka]: https://github.com/albertvaka
[bboozzoo]: https://github.com/bboozzoo
[hugosenari]: https://github.com/hugosenari
[RaphaelRochet]: https://github.com/RaphaelRochet
[tooltips]: https://github.com/RaphaelRochet/applications-overview-tooltip
[Bajoja]: https://github.com/Bajoja
[d0od88]: https://github.com/d0od88
[ptomato]: https://github.com/ptomato
[pwithnall]: https://github.com/pwithnall
[nielsdg]: https://github.com/nielsdg
[vimix]: https://github.com/vinceliuice/vimix-gtk-themes
[numix]: https://numixproject.org/
[material]: https://material.io/



