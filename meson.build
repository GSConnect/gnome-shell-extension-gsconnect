project('gsconnect', 'c', version: '2', meson_version: '>= 0.40.1')

# User Definable Variables
Name = 'GSConnect'
UUID = meson.project_name() + '@andyholmes.github.io'

# Extension
extension_source = files(
  # standard files
  'src/extension.js',
  'src/prefs.js',
  # non-standard files
  'src/client.js',
  'src/common.js',
  # non-GJS files
  'src/nautilus-gsconnect.py',
  'src/folks.py'
)


# You shouldn't need to edit anything below.
#------------------------------------------------------------------------------

gnome = import('gnome')
extdatadir = join_paths(get_option('datadir'), 'gnome-shell/extensions', UUID)

# ZIP targets
run_target('make-zip', command: ['meson/zip.sh', UUID])
run_target('install-zip', command: ['meson/zip.sh', UUID, 'install'])

# Extension Source
install_data(
  extension_source,
  install_dir: extdatadir,
  install_mode: 'rw-r--r--'
)

# Service Source
install_subdir('src/service', install_dir: extdatadir)
install_subdir('src/widgets', install_dir: extdatadir)

# metadata.json
ext_metadata = configuration_data()
ext_metadata.set('EXTENSION_ID', meson.project_name())
ext_metadata.set('UUID', UUID)
ext_metadata.set('VERSION', meson.project_version())

metadata_json = configure_file(
  input: 'data/metadata.json.in',
  output: 'metadata.json',
  configuration: ext_metadata
)
install_data(
  metadata_json,
  install_dir: extdatadir,
  install_mode: 'rw-r--r--'
)

# GSettings
install_data(
    join_paths('data', 'org.gnome.shell.extensions.gsconnect.gschema.xml'),
    install_dir: join_paths(extdatadir, 'schemas')
)

# GResource
gnome.compile_resources(
  'org.gnome.shell.extensions.gsconnect',
  join_paths('data', 'org.gnome.shell.extensions.gsconnect.gresource.xml'),
  source_dir: 'data',
  gresource_bundle: true,
  install: true,
  install_dir : extdatadir
)

# Gettext Translations
subdir('po')

