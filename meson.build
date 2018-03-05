project('gsconnect', 'c', version: '10', meson_version: '>= 0.40.1')

gnome = import('gnome')
extuuid = meson.project_name() + '@andyholmes.github.io'
extdatadir = join_paths(get_option('datadir'), 'gnome-shell/extensions', extuuid)

# ZIP targets
run_target('make-zip', command: ['meson/zip.sh', extuuid])
run_target('install-zip', command: ['meson/zip.sh', extuuid, 'install'])

# Source Files
extension_source = files(
  # standard files
  'src/extension.js',
  'src/prefs.js',
  'src/stylesheet.css',
  # non-standard files
  'src/_bootstrap.js',
  'src/actors.js',
  # non-GJS files
  'src/nautilus-gsconnect.py'
)

install_data(
  extension_source,
  install_dir: extdatadir,
  install_mode: 'rw-r--r--'
)

install_subdir('src/modules', install_dir: extdatadir)
install_subdir('src/service', install_dir: extdatadir)
install_subdir('src/widgets', install_dir: extdatadir)

# metadata.json
extmetadata = configuration_data()
extmetadata.set('VERSION', meson.project_version())

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

# GSettings
install_data(
    join_paths('data', 'org.gnome.Shell.Extensions.GSConnect.gschema.xml'),
    install_dir: join_paths(extdatadir, 'schemas')
)

# GResource
gnome.compile_resources(
  'org.gnome.Shell.Extensions.GSConnect.data',
  join_paths('data', 'org.gnome.Shell.Extensions.GSConnect.data.gresource.xml'),
  source_dir: 'data',
  gresource_bundle: true,
  install: true,
  install_dir : extdatadir
)

# Gettext Translations
subdir('po')

