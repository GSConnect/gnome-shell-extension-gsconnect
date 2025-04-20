# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

subdir('firewalld')
subdir('metainfo')
subdir('webextension')

# metadata.json
configure_file(
  input: 'metadata.json.in',
  output: 'metadata.json',
  configuration: extconfig,
  install_dir: extdatadir
)

# config.js
configure_file(
  input: 'config.js.in',
  output: 'config.js',
  configuration: extconfig,
  install_dir: extdatadir
)

# Desktop Entry
desktop_file = configure_file(
  input: app_id + '.desktop.in',
  output: app_id + '.desktop',
  configuration: extconfig,
  install_dir: join_paths(datadir, 'applications')
)

desktop_prefs_file = configure_file(
  input: app_id + '.Preferences.desktop.in',
  output: app_id + '.Preferences.desktop',
  configuration: extconfig,
  install_dir: join_paths(datadir, 'applications')
)

desktop_utils = find_program('desktop-file-validate', required: false)

if desktop_utils.found()
  test('Validate desktop file', desktop_utils,
    args: [desktop_file],
    suite: 'data',
  )
  test('Validate desktop file (Preferences)', desktop_utils,
    args: [desktop_prefs_file],
    suite: 'data',
  )
endif

scalable_dir = join_paths('icons', 'hicolor', 'scalable', 'apps')
install_data(
  join_paths(scalable_dir, ('@0@.svg').format(app_id)),
  install_dir: join_paths(datadir, 'icons', scalable_dir)
)

symbolic_dir = join_paths('icons','hicolor', 'symbolic', 'apps')
install_data(
  join_paths(symbolic_dir, ('@0@-symbolic.svg').format(app_id)),
  install_dir: join_paths(datadir, 'icons', symbolic_dir)
)

# DBus Service
dbus = dependency('dbus-1', required: false)

if get_option('session_bus_services_dir') != ''
  dbus_dir = get_option('session_bus_services_dir')
elif dbus.found()
  dbus_dir = dbus.get_variable(
    pkgconfig: 'session_bus_services_dir',
    internal: 'session_bus_services_dir',
    default_value: join_paths(datadir, 'dbus-1', 'services'),
  )
else
  dbus_dir = join_paths(datadir, 'dbus-1', 'services')
endif

dbus_service_file = configure_file(
  input: app_id + '.service.in',
  output: app_id + '.service',
  configuration: extconfig,
  install_dir: dbus_dir
)

# GSettings
install_data(
  app_id + '.gschema.xml',
  install_dir: gschemadir
)

# GResource
gnome.compile_resources(
  app_id,
  app_id + '.gresource.xml',
  gresource_bundle: true,
  install: true,
  install_dir: extdatadir,
  dependencies: [
    desktop_file,
    desktop_prefs_file,
    dbus_service_file
  ]
)

