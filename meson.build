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
Shell = [ '3.24', '3.26' ]

# Extension
extension_source = files(
  # standard files
  'src/extension.js',
  'src/prefs.js',
  'data/stylesheet.css',
  # non-standard files
  'src/client.js',
  'src/common.js',
  'src/gsettingsWidget.js',
  'src/share.js',
  'src/sms.js',
  # non-GJS files
  'src/nautilus-send-gsconnect.py',
  'src/folks.py'
)

# Service
service_source = files(
  'src/service/config.js',
  'src/service/daemon.js',
  'src/service/device.js',
  'src/service/protocol.js'
)

# Plugins
plugins_source = files(
  'src/plugins/base.js',
  'src/plugins/battery.js',
  'src/plugins/findmyphone.js',
  'src/plugins/notifications.js',
  'src/plugins/ping.js',
  'src/plugins/runcommand.js',
  'src/plugins/share.js',
  'src/plugins/telephony.js',
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
install_data(
  service_source,
  install_dir: join_paths(extdatadir, 'service'),
  install_mode: 'rw-r--r--'
)

# Plugins Source
install_data(
  plugins_source,
  install_dir: join_paths(extdatadir, 'plugins'),
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
ext_metadata.set('GETTEXT_DOMAIN', 'org.gnome.shell.extensions.' + ExtensionId)

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

