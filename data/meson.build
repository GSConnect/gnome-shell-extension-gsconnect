subdir('firewalld')
subdir('metainfo')


# metadata.json
configure_file(
  input: 'metadata.json.in',
  output: 'metadata.json',
  configuration: extconfig,
  install_dir: extdatadir
)


# Desktop Entry
desktop_file = configure_file(
  input: 'org.gnome.Shell.Extensions.GSConnect.desktop',
  output: 'org.gnome.Shell.Extensions.GSConnect.desktop',
  configuration: extconfig,
  install_dir: join_paths(datadir, 'applications')
)

desktop_prefs_file = configure_file(
  input: 'org.gnome.Shell.Extensions.GSConnect.Preferences.desktop',
  output: 'org.gnome.Shell.Extensions.GSConnect.Preferences.desktop',
  configuration: extconfig,
  install_dir: join_paths(datadir, 'applications')
)

desktop_utils = find_program('desktop-file-validate', required: false)

if desktop_utils.found()
  test('Validate desktop file', desktop_utils,
    args: [desktop_file]
  )
  test('Validate desktop file (Preferences)', desktop_utils,
    args: [desktop_prefs_file]
  )
endif


# Application Icon
install_data([
  'icons/org.gnome.Shell.Extensions.GSConnect.svg',
  'icons/org.gnome.Shell.Extensions.GSConnect-symbolic.svg'],
  install_dir: join_paths(datadir, 'icons', 'hicolor', 'scalable', 'apps')
)


# DBus Service
dbus = dependency('dbus-1', required: false)

if get_option('session_bus_services_dir') != ''
  dbus_dir = get_option('session_bus_services_dir')
elif dbus.found()
  dbus_dir = dbus.get_pkgconfig_variable('session_bus_services_dir')
else
  dbus_dir = join_paths(datadir, 'dbus-1', 'services')
endif

configure_file(
  input: 'org.gnome.Shell.Extensions.GSConnect.service',
  output: 'org.gnome.Shell.Extensions.GSConnect.service',
  configuration: extconfig,
  install_dir: dbus_dir
)


# WebExtension Manifests
if get_option('webextension')
  nmh_manifest = 'org.gnome.shell.extensions.gsconnect.json'

  # Chrome
  if get_option('chrome_nmhdir') != ''
    chrome_nmhdir = get_option('chrome_nmhdir')
  else
    chrome_nmhdir = join_paths(sysconfdir, 'opt', 'chrome', 'native-messaging-hosts')
  endif

  chrome_nmh = configure_file(
    input: 'org.gnome.shell.extensions.gsconnect.json-chrome',
    output: 'org.gnome.shell.extensions.gsconnect.json-chrome',
    configuration: extconfig
  )

  install_data(
    chrome_nmh,
    rename: join_paths(chrome_nmhdir, nmh_manifest)
  )

  # Chromium
  if get_option('chromium_nmhdir') != ''
    chromium_nmhdir = get_option('chromium_nmhdir')
  else
    chromium_nmhdir = join_paths(sysconfdir, 'chromium', 'native-messaging-hosts')
  endif

  chromium_nmh = configure_file(
    input: 'org.gnome.shell.extensions.gsconnect.json-chrome',
    output: 'org.gnome.shell.extensions.gsconnect.json-chromium',
    configuration: extconfig
  )

  install_data(
    chromium_nmh,
    rename: join_paths(chromium_nmhdir, nmh_manifest)
  )

  # Mozilla
  if get_option('mozilla_nmhdir') != ''
    mozilla_nmhdir = get_option('mozilla_nmhdir')
  else
    mozilla_nmhdir = join_paths(libdir, 'mozilla', 'native-messaging-hosts')
  endif

  configure_file(
    input: 'org.gnome.shell.extensions.gsconnect.json-mozilla',
    output: nmh_manifest,
    configuration: extconfig,
    install_dir: mozilla_nmhdir
  )
endif


# GSettings
install_data(
    'org.gnome.Shell.Extensions.GSConnect.gschema.xml',
    install_dir: gschemadir
)


# GResource
gnome.compile_resources(
  'org.gnome.Shell.Extensions.GSConnect',
  'org.gnome.Shell.Extensions.GSConnect.gresource.xml',
  gresource_bundle: true,
  install: true,
  install_dir: extdatadir
)
