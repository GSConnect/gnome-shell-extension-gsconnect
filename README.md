# KDE Connect implementation for Gnome Shell 3.24+

![Extension Screenshot][screenshot]

## Overview

GSConnect is a complete [KDE Connect][kdeconnect] protocol implementation
for Gnome Shell 3.24+ with Nautilus, Chrome and Firefox integration. See the
[Wiki][wiki] for more information.


### Getting Started

The easiest way to get started is to install the extension from the official
[GNOME Shell Extensions website][ego-install]. There are also instructions in
the Wiki for [installing the latest stable release][wiki-install] and a
[full list of dependencies][wiki-depends].

The [Chrome extension][chrome-extension] and [Firefox Add-on][firefox-addon]
can be installed after [Web Browser Integration][web-browser-integration] has
been enabled in the preferences.

To connect an Android device, install the KDE Connect Android app from the
[Google Play Store][google-play] or [F-Droid][f-droid].

### Getting Help

Please the [FAQ][wiki-faq] in the Wiki for answers to common questions before
[opening an issue][git-issue] to report a problem or request a new feature.

The KDE Connect team has resources available for problems, feature requests and
contributions related to Android App:

* [Bug Tracker][kdec-bugs]
* [Phabricator][kdec-phabricator]
* [KDE Connect Mailing List][kdec-mail]
    
### Credits

Code from [python-folks][python-folks] by [@hugosenari][hugosenari] was adapted
to provide libfolks integration.

Code from [application-overview-tooltip][tooltips] by
[@RaphaelRochet][RaphaelRochet] was adapted to provide tooltips.

Code from [kdeconnect-chrome-extension][kdeconnect-chrome-extension] by
[@pdf][pdf] was used as a template for the Web Extension.

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

[ego-install]: https://extensions.gnome.org/extension/1319/gsconnect/
[wiki-zip]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#installing-from-zip
[wiki-install]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation
[wiki-git]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#building-from-git
[wiki-depends]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#dependencies
[web-browser-integration]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Preferences#web-browser-integration
[chrome-extension]: https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec
[firefox-addon]: https://addons.mozilla.org/en-US/firefox/addon/gsconnect/

[git-issue]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues/
[wiki-faq]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Frequently-Asked-Questions
[kdec-bugs]: https://bugs.kde.org/buglist.cgi?quicksearch=kdeconnect
[kdec-phabricator]: https://phabricator.kde.org/project/view/159/
[kdec-mail]: https://mail.kde.org/mailman/listinfo/kdeconnect

[kdeconnect]: https://community.kde.org/KDEConnect
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/
[mconnect]: https://github.com/bboozzoo/mconnect
[gconnect]: https://github.com/getzze/gconnect
[kindicator]: https://github.com/Bajoja/indicator-kdeconnect

[hugosenari]: https://github.com/hugosenari
[python-folks]: https://github.com/hugosenari/folks
[RaphaelRochet]: https://github.com/RaphaelRochet
[tooltips]: https://github.com/RaphaelRochet/applications-overview-tooltip
[pdf]: https://github.com/pdf
[kdeconnect-chrome-extension]: https://github.com/pdf/kdeconnect-chrome-extension
[numix]: https://numixproject.github.io/
[material]: https://material.io/

[albertvaka]: https://github.com/albertvaka
[ptomato]: https://github.com/ptomato
[pwithnall]: https://github.com/pwithnall
[nielsdg]: https://github.com/nielsdg
[omgubuntu]: http://www.omgubuntu.co.uk/
