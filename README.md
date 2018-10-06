# KDE Connect implementation for Gnome Shell 3.24+

![Extension Screenshot][screenshot]

> ## ATTENTION
>
> GSConnect is in the process of merging a rewrite. It is approaching maturity,
> but introduces major changes and has not been thoroughly tested. Support has
> has always been positive and your patience is appreciated.
>
> **Translators:** translatable strings are not finalized and pull requests for
> translations will be considered work-in-progress until further notice.
> Subscribe to the [Translations Discussion thread][translating] to receive
> updates.
>
> For more information, see [Roadmap][roadmap].

## Overview

> **NOTE:** The current stable release (v12) does not support Gnome Shell 3.30.
> Please see [Issue #186](https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues/186)
> for a fixed Zip.

The [KDE Connect][kdeconnect] project allows devices to securely share content
such as notifications and files as well as interactive features such as SMS
messaging and remote input. The KDE Connect team maintains cross-desktop,
Android and Sailfish applications as well as an interface for KDE Plasma.

GSConnect is a complete implementation of KDE Connect especially for Gnome Shell
with Nautilus, Chrome and Firefox integration. It is does not rely on the KDE
Connect desktop application and will not work with it installed.

See [Related Projects](#related-projects) for a list of implementations.

### Getting Started

The easiest way to get started is to install the extension from the official
[GNOME Shell Extensions website][ego-install]. The Wiki has a short guide for
[pairing your first device][wiki-install] and a [list of dependencies][wiki-depends].

The [Chrome extension][chrome-extension] and [Firefox Add-on][firefox-addon]
can be installed after [Web Browser Integration][web-browser-integration] has
been enabled in the preferences.

To connect a mobile device, install the KDE Connect Android app from the
[Google Play Store][google-play] or [F-Droid][f-droid], or the Sailfish app from
[OpenRepos][open-repos].

### Getting Help

Please see the [FAQ][wiki-faq] before opening a [New Issue][git-issue] to report
a problem or request a new feature. There is also a IRC/Matrix channel available
for general discussion:

* Matrix: https://matrix.to/#/#_gimpnet_#gsconnect:matrix.org
* IRC: irc://irc.gimp.org/#gsconnect

The KDE Connect team has resources available for problems and contributions to
their desktop, Android and Sailfish applications. Additionally, any protocol
related discussion should take place upstream within the KDE Connect project.

* [Bug Tracker][kdec-bugs]
* [Phabricator][kdec-phabricator]
* [Mailing List][kdec-mail]
* [Telegram (Development)][kdec-telegram]

### Credits

Code and assistance from [@getzze][getzze] implementing Bluetooth support.

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

Most of all thank you to users, translators, bug reporters and contributors.

[@albertvaka][albertvaka], [@nicolasfella][nicolasfella], [@aleixpol][aleixpol],
[@mtijink][mtijink], [@sredman][sredman] and others for creating KDE Connect.

[@ptomato][ptomato], [@pwithnall][pwithnall], [@nielsdg][nielsdg],
[@TingPing][TingPing] and others for help with Gnome APIs.

[@didrocks][didrocks] and [@jtojnar][jtojnar] for help supporting distribution
packaging.

[@piotrdrag][piotrdrag] for help and advice with translation support.

The many blogs and news sites reporting with screenshots and user guides,
especially those sharing GSConnect with non-English speaking users.


[screenshot]: https://raw.githubusercontent.com/andyholmes/gnome-shell-extension-gsconnect/master/extra/screenshot.png
[translating]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues/1
[roadmap]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Roadmap

[ego-install]: https://extensions.gnome.org/extension/1319/gsconnect/
[wiki-install]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation
[wiki-depends]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#dependencies
[web-browser-integration]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Preferences#web-browser-integration
[chrome-extension]: https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec
[firefox-addon]: https://addons.mozilla.org/firefox/addon/gsconnect/

[git-issue]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/issues/
[wiki-faq]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Frequently-Asked-Questions
[kdec-bugs]: https://bugs.kde.org/buglist.cgi?quicksearch=kdeconnect
[kdec-phabricator]: https://phabricator.kde.org/project/view/159/
[kdec-mail]: https://mail.kde.org/mailman/listinfo/kdeconnect
[kdec-telegram]: https://t.me/joinchat/AOS6gA37orb2dZCLhqbZjg

[kdeconnect]: https://community.kde.org/KDEConnect
[google-play]: https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp
[f-droid]: https://f-droid.org/packages/org.kde.kdeconnect_tp/
[open-repos]: https://openrepos.net/content/piggz/kde-connect
[mconnect]: https://github.com/bboozzoo/mconnect
[gconnect]: https://github.com/getzze/gconnect
[kindicator]: https://github.com/Bajoja/indicator-kdeconnect

[getzze]: https://github.com/getzze
[hugosenari]: https://github.com/hugosenari
[python-folks]: https://github.com/hugosenari/folks
[RaphaelRochet]: https://github.com/RaphaelRochet
[tooltips]: https://github.com/RaphaelRochet/applications-overview-tooltip
[pdf]: https://github.com/pdf
[kdeconnect-chrome-extension]: https://github.com/pdf/kdeconnect-chrome-extension
[numix]: https://numixproject.github.io/
[material]: https://material.io/

[albertvaka]: https://github.com/albertvaka
[aleixpol]: https://github.com/aleixpol
[nicolasfella]: https://github.com/nicolasfella
[mtijink]: https://github.com/mtijink
[sredman]: https://github.com/sredman

[ptomato]: https://github.com/ptomato
[pwithnall]: https://github.com/pwithnall
[nielsdg]: https://github.com/nielsdg
[TingPing]: https://github.com/TingPing

[didrocks]: https://github.com/didrocks
[jtojnar]: https://github.com/jtojnar

[piotrdrag]: https://github.com/piotrdrag
