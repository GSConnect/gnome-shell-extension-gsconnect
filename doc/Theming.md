---
title: Theming
---
> ***THIS PAGE IS INCOMPLETE AND/OR OUTDATED***

> **Note to Users**
>
> This documentation is meant for Gtk and Gnome Shell themers. If you encounter a bug specific to a Gtk or Gnome Shell theme, you should file a *downstream* bug report with the theme maintainer and direct them to this page.

GSConnect is made of two distinct parts; the Gnome Shell extension and the service daemon. There is custom CSS for some Clutter/St widgets in the Gnome Shell extension (`stylesheet.css`) and Gtk widgets used in the GSConnect service (`application.css`).

### Gnome Shell

The Shell extension includes default CSS rules in [`stylesheet.css`][stylesheet-css] and is more likely the CSS you will change as a themer.

#### Device Menu

> ***This description is quite out of date as of v15***

 The main UI widget in GSConnect is the **Device Menu**, used in both the User Menu and Indicator display modes, which inherits from `.popup-menu-item`.

Of special note is the `.gsconnect-device-button` which is the circular widget with device icon in the center. The child `StDrawingArea` will scale itself to the desktop scale factor and the width/height given (more details in [`stylesheet.css`][stylesheet-css]).

* `PopupMenu.PopupBaseMenuItem.gsconnect-device` (inherits from `.popup-menu-item`)
  * `StButton.gsconnect-device-button`
    * `StDrawingArea`
  * `StBoxLayout.gsconnect-device-box`
    * `StBoxLayout.gsconnect-device-title`
      * `StLabel.gsconnect-device-name`
        * `StWidget.popup-separator-menu-item`
        * `StBoxLayout.gsconnect-device-battery`
          * `StLabel`
          * `StIcon`
    * `StBoxLayout.gsconnect-device-actions`
      * `StButton.gsconnect-device-action` (inherits from `.system-menu-action`)
        * `StIcon`
    * `StBoxLayout.gsconnect-device-status`
      * `StLabel`

#### Do Not Disturb

This dialog generally inherits from the Network Manager dialog (`.nm-dialog`) in Gnome Shell, but provides a top-level class `.gsconnect-dnd-dialog` to make overriding easier. There are also classes for the timer and radio button widgets (currently only used in this dialog):

* `ModalDialog.ModalDialog.gsconnect-dnd-dialog` (inherits from `.nm-dialog`)
  * `StBoxLayout.nm-dialog-header-hbox`
    * `StIcon.nm-dialog-header-icon`
    * `StBoxLayout`
      * `StLabel.nm-dialog-header`
      * `StLabel.nm-dialog-subheader`
    * `StBoxLayout.nm-dialog-content`
      * `StBoxLayout.gsconnect-radio-list`
        * `StBoxLayout.gsconnect-radio-button` (Until you turn off...)
          * `StButton.pager-button`
            * `StIcon`
          * `StLabel`
        * `StBoxLayout.gsconnect-radio-button` (Until 00:00)
          * `StButton.pager-button`
            * `StIcon`
          * `StBoxLayout.gsconnect-dnd-timer`
            * `StLabel`
            * `StButton.pager-button`
              * `StIcon`
            * `StButton.pager-button`
              * `StIcon`

#### Tooltips

GSConnect uses custom tooltip widgets with an object hierarchy like so:

* `StBin.gsconnect-tooltip`
  * `StBoxLayout`
    * `StIcon`
    * `StLabel`

### Gtk

The service includes default CSS rules in [`application.css`][application-css], which has a few classes of interest.

* **`.badge-button`**

  Used for the Chrome and Firefox buttons in Preferences -> Other.

* **`.message-in`**
* **`.message-out`**

  Used for message bubbles in the SMS/Messaging window, which are a subclass of `GtkLabel`. Incoming messages are always aligned to the left side and outgoing messages to the right side, regardless of language direction.

  Message bubbles may have links in them, with `color` set to `@theme_selected_fg_color` by default to contrast with the default `background` of `@theme_selected_bg_color` (20% or 100% opacity).


[application-css]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/data/application.css
[stylesheet-css]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/blob/master/src/stylesheet.css
