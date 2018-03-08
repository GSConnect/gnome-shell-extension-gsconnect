# KDE Connect implementation for Gnome Shell 3.26+

## Overview

This is a work in progress branch, representing a major rewrite of GSConnect.
It's generally stable at this point, which is to say it won't crash, cause
Gnome Shell to crash, cause data loss or any other nasty consequences. That
being said, many features just don't work, don't work well or sometimes cause
minor hangs (a few seconds of unresponsiveness).

You're welcome to try it out, however I would recommend you unpair your devices
and wipe GSettings for GSConnect before doing so. If you don't know how do that,
you probably shouldn't be testing this.

**Some hightlights:**

* This version will leverage many JavaScript ES6 features, requiring at least
  Gnome Shell 3.26
* The notion of "plugins" is a bit of a misnomer in KDE Connect, since they
  aren't truly pluggable in any meaningful sense and clients don't report
  which plugins are actually loaded. There will be a general shift from the
  paradigm of **plugins** to **actions** and **events**. Among other things,
  this means:
  * Capability/packet handlers, will be loaded automatically based on the
    device's claim that it supports them.
  * Many DBus interfaces are being replaced in favour or GActions and GMenus
    exported over DBus. This will include presentation details like icons and
    translated strings, making integrating GSConnect functionality into other
    extensions and programs much easier.
  * Settings will be much coarser with presumptuous defaults, while at the same
    time extremely fine-grained behaviour can be defined from the settings GUI.
* Many features will be removed from the extension interface (eg. Device Menu)
  and integrated into the desktop environment, Nautilus, the dock or elsewhere.
* There will be a number of improvements to notifications such as properly
  handling close events, and a "Do not disturb" feature similar to Android.
* Gnome/Gtk desktop settings will be better leveraged to respect user
  preferences.
* Many plugins, especially Telephony, are being entirely rewritten to address
  a number of long-standing annoyances and some simulated features will be
  removed like mutli-recipient conversations which will be replaced with a
  batch-send feature.
  
