project(
  'gnome-shell-extension-gsconnect',
  'c',
  version: '1',
  meson_version: '>= 0.40.1',
)

# User Definable Variables
Name = 'GSConnect'
Description = 'KDE Connect protocol implementation and integration for Gnome Shell'
ExtensionId = meson.project_name().split('gnome-shell-extension-')[1]
UUID = ExtensionId + '@' + 'andyholmes.github.io'
URL = 'https://github.com/andyholmes/gnome-shell-extension-gsconnect'
Shell = [ '3.18', '3.20', '3.22', '3.24', '3.26' ]

# A list of files to be copied to the extension directory without modification.
Files = files(
  # standard files
  'src/extension.js',
  'src/prefs.js',
  'data/stylesheet.css',
  # non-standard files
  'src/lib.js',
  'src/kdeconnect.js',
  'src/mconnect.js',
  'src/share.js',
  'src/sms.js',
  # non-GJS files
  'src/nautilus-send-mconnect.py',
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
  Files,
  install_dir: extdatadir,
  install_mode: 'rw-r--r--'
)

# metadata.json
ext_metadata = configuration_data()
ext_metadata.set('NAME', Name)
ext_metadata.set('DESCRIPTION', Description)
ext_metadata.set('EXTENSION_ID', ExtensionId)
ext_metadata.set('UUID', UUID)
ext_metadata.set('VERSION', meson.project_version())
ext_metadata.set('URL', URL)
ext_metadata.set('SHELL_VERSION', '[ "' + '", "'.join(Shell) + '" ]')
ext_metadata.set('GSCHEMA_ID', 'org.gnome.shell.extensions.' + ExtensionId)
ext_metadata.set('GETTEXT_DOMAIN', meson.project_name())

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
    join_paths('data', ext_metadata.get('GSCHEMA_ID') + '.gschema.xml'),
    install_dir: join_paths(extdatadir, 'schemas')
)

# GResource
gnome.compile_resources(
  ext_metadata.get('GSCHEMA_ID'),
  join_paths('data', ext_metadata.get('GSCHEMA_ID') + '.gresource.xml'),
  source_dir: 'data',
  gresource_bundle: true,
  install: true,
  install_dir : extdatadir
)

# Gettext Translations
if run_command('[', '-e', 'po/meson.build', ']').returncode() == 0
    subdir('po')
endif

