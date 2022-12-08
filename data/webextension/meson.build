# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

# WebExtension Manifests
if get_option('webextension')
  nmh_manifest = 'org.gnome.shell.extensions.gsconnect.json'

  # Google (Chrome/Chromium)
  google_nmh = configure_file(
    input: 'org.gnome.shell.extensions.gsconnect.json.google.in',
    output: 'org.gnome.shell.extensions.gsconnect.json.google',
    configuration: extconfig
  )

  chrome_nmhdir = get_option('chrome_nmhdir')

  if chrome_nmhdir == ''
    chrome_nmhdir = join_paths(sysconfdir, 'opt', 'chrome', 'native-messaging-hosts')
  endif

  install_data(
    google_nmh,
    rename: join_paths(chrome_nmhdir, nmh_manifest)
  )

  chromium_nmhdir = get_option('chromium_nmhdir')

  if chromium_nmhdir == ''
    chromium_nmhdir = join_paths(sysconfdir, 'chromium', 'native-messaging-hosts')
  endif

  install_data(
    google_nmh,
    rename: join_paths(chromium_nmhdir, nmh_manifest)
  )

  # Mozilla
  mozilla_nmh = configure_file(
    input: 'org.gnome.shell.extensions.gsconnect.json.mozilla.in',
    output: 'org.gnome.shell.extensions.gsconnect.json.mozilla',
    configuration: extconfig
  )

  mozilla_nmhdir = get_option('mozilla_nmhdir')

  if mozilla_nmhdir == ''
    mozilla_nmhdir = join_paths(libdir, 'mozilla', 'native-messaging-hosts')
  endif

  install_data(
    mozilla_nmh,
    rename: join_paths(mozilla_nmhdir, nmh_manifest)
  )
endif

