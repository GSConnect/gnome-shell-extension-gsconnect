---
title: Translating
---
Thank you for considering contributing a translation to this project. I know it takes a lot of time and effort and I try to make it as easy as possible. The WebExtension translations are now handled automatically, so you only need to translate the standard POT file.

Consider subscribing to the [Translation Thread](../issues/1) to be notified of changes and updates. I usually give notice before the next release, and you can ask for more time to get your translation into the next release.

### Getting setup

To contribute a translation you'll need a [GitHub account](https://github.com/join), `git`, [`meson`](http://mesonbuild.com) and a translation program like [POEdit][poedit]. Once you have everything, create a fork on Github:

<img src="https://github-images.s3.amazonaws.com/help/bootcamp/Bootcamp-Fork.png" height="74" width="369"/>

Then clone your fork with `git` and setup the project with `meson`:

```sh
$ git clone https://github.com/<your_username>/gnome-shell-extension-gsconnect.git
$ meson gnome-shell-extension-gsconnect _build
```

### Creating a Translation

1. Ensure the translation template is updated and aligned:

   ```sh
   git -C gnome-shell-extension-gsconnect pull
   ninja -C _build org.gnome.Shell.Extensions.GSConnect-pot
   ninja -C _build org.gnome.Shell.Extensions.GSConnect-update-po
   ```

2. Use a program such as [POEdit][poedit] to create a new translation for your language from `gnome-shell-extension-gsconnect/po/org.gnome.Shell.Extensions.GSConnect.pot`.

   Save your translation in `gnome-shell-extension-gsconnect/po/` and make sure the language code for your translation is in `gnome-shell-extension-gsconnect/po/LINGUAS`. For example, if your translation is named `fr.po` it should have `fr` on its own line:

   ```
   es
   fr
   pl
   ```

3. To test your translation install the extension and restart Gnome Shell:

   ```sh
   ninja -C _build install-zip
   ```

   If you are using X11/Xorg you can restart Gnome Shell with <kbd>Alt</kbd> + <kbd>F2</kbd> then `restart`. If you are using Wayland you must restart your session.

4. When you're happy with your translation, commit the changes and push them to your fork:

   ```sh
   cd gnome-shell-extension-gsconnect
   git commit -a -m "Add/update French translation"
   git push
   ```

5. Then open a new [Pull Request][pull-request] from your fork at `https://github.com/<your_username>/gnome-shell-extension-gsconnect`.

   ![...](https://github-images.s3.amazonaws.com/help/pull_requests/recently_pushed_branch.png)

[pull-request]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/pulls
[pot]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/tree/master/po/org.gnome.Shell.Extensions.GSConnect.pot
[po]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/tree/master/po/
[poedit]: https://poedit.net/
[linguas]: https://github.com/andyholmes/gnome-shell-extension-gsconnect/tree/master/po/LINGUAS
