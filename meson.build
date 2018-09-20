project('gsconnect', 'c', version: '13', meson_version: '>= 0.45.0')

gnome = import('gnome')

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
libdir = join_paths(prefix, get_option('libdir'))
localedir = join_paths(prefix, get_option('localedir'))
sysconfdir = get_option('sysconfdir')

extuuid = 'gsconnect@andyholmes.github.io'
extdatadir = join_paths(datadir, 'gnome-shell', 'extensions', extuuid)
gschemadir = join_paths(datadir, 'glib-2.0', 'schemas')

# Gnome Shell LIBDIR
if get_option('gnome_shell_libdir') != ''
  gnome_shell_libdir = get_option('gnome_shell_libdir')
else
  gnome_shell_dir = libdir
endif

# Mozilla LIBDIR
if get_option('mozilla_libdir') != ''
  mozilla_libdir = get_option('mozilla_libdir')
else
  mozilla_dir = libdir
endif

# Configuration
extconfig = configuration_data()
extconfig.set('VERSION', meson.project_version())
extconfig.set('LIBDIR', libdir)
extconfig.set('GNOME_SHELL_LIBDIR', gnome_shell_libdir)
extconfig.set('MOZILLA_LIBDIR', mozilla_libdir)
extconfig.set('LOCALEDIR', localedir)
extconfig.set('EXTDATADIR', extdatadir)
extconfig.set('GSCHEMADIR', gschemadir)

# ZIP targets for user extension builds
run_target(
    'make-zip',
    command: [
        find_program('env'),
        'UUID=' + extuuid,
        'DATADIR=' + datadir,
        'INSTALL=false',
        'meson/mkzip.sh'
    ]
)
run_target(
    'install-zip',
    command: [
        find_program('env'),
        'UUID=' + extuuid,
        'DATADIR=' + datadir,
        'INSTALL=true',
        'meson/mkzip.sh'
    ]
)

# Extension Source
install_subdir(
  'src',
  install_dir: extdatadir,
  strip_directory: true
)

# metadata.json
configure_file(
  input: 'data/metadata.json.in',
  output: 'metadata.json',
  configuration: extconfig,
  install_dir: extdatadir
)

# Desktop Entry
install_data(
    'data/org.gnome.Shell.Extensions.GSConnect.desktop',
    install_dir: join_paths(datadir, 'applications')
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
  input: 'data/org.gnome.Shell.Extensions.GSConnect.service',
  output: 'org.gnome.Shell.Extensions.GSConnect.service',
  configuration: extconfig,
  install_dir: dbus_dir
)

# Nautilus Extension
if get_option('nautilus')
  install_data(
    'src/nautilus-gsconnect.py',
    install_dir: join_paths(datadir, 'nautilus-python', 'extensions')
  )
endif

# WebExtension Manifests
if get_option('webextension')
  configure_file(
    input: 'data/org.gnome.shell.extensions.gsconnect.json-chrome',
    output: 'org.gnome.shell.extensions.gsconnect.json-chrome',
    configuration: extconfig
  )
  # HACK: use 'rename' in meson >=0.46.0
  meson.add_install_script('meson/nmh.sh', sysconfdir)

  configure_file(
    input: 'data/org.gnome.shell.extensions.gsconnect.json-mozilla',
    output: 'org.gnome.shell.extensions.gsconnect.json',
    configuration: extconfig,
    install_dir: join_paths(mozilla_libdir, 'mozilla', 'native-messaging-hosts')
  )
endif

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

