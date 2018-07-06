project('gsconnect', 'c', version: '13', meson_version: '>= 0.45.0')

gnome = import('gnome')

extuuid = 'gsconnect@andyholmes.github.io'
prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
extdatadir = join_paths(datadir, 'gnome-shell/extensions', extuuid)

# ZIP targets
run_target(
    'make-zip',
    command: ['meson/zip.sh', extuuid, datadir]
)
run_target(
    'install-zip',
    command: ['meson/zip.sh', extuuid, datadir, 'install']
)

# metadata.json
extmetadata = configuration_data()
extmetadata.set('VERSION', meson.project_version())
extmetadata.set('EXTDATADIR', extdatadir)

# Extension Source
install_subdir(
  'src',
  install_dir: extdatadir,
  strip_directory: true
)

# metadata.json
metadata_json = configure_file(
  input: 'data/metadata.json.in',
  output: 'metadata.json',
  configuration: extmetadata
)
install_data(
  metadata_json,
  install_dir: extdatadir,
  install_mode: 'rw-r--r--'
)

# Desktop Entry
configure_file(
  input: 'data/org.gnome.Shell.Extensions.GSConnect.desktop',
  output: 'org.gnome.Shell.Extensions.GSConnect.desktop',
  configuration: extmetadata,
  install_dir: join_paths(datadir, 'applications')
)

# DBus Service
configure_file(
  input: 'data/org.gnome.Shell.Extensions.GSConnect.service',
  output: 'org.gnome.Shell.Extensions.GSConnect.service',
  configuration: extmetadata,
  install_dir: join_paths(datadir, 'dbus-1', 'services')
)

# Nautilus Extension
install_data(
  'src/nautilus-gsconnect.py',
  install_dir: join_paths(datadir, 'nautilus-python', 'extensions')
)

# GSettings
install_data(
    'data/org.gnome.Shell.Extensions.GSConnect.gschema.xml',
    install_dir: join_paths(datadir, 'glib-2.0', 'schemas')
)

# GResource
gnome.compile_resources(
  'org.gnome.Shell.Extensions.GSConnect',
  'data/org.gnome.Shell.Extensions.GSConnect.gresource.xml',
  source_dir: 'data',
  gresource_bundle: true,
  install: true,
  install_dir: extdatadir
)

# Gettext Translations
subdir('po')

