project('gsconnect', 'c', version: '39', meson_version: '>= 0.49.0')

gnome = import('gnome')
i18n = import('i18n')

app_id = 'org.gnome.Shell.Extensions.GSConnect'
extuuid = 'gsconnect@andyholmes.github.io'

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
libdir = join_paths(prefix, get_option('libdir'))
localedir = join_paths(prefix, get_option('localedir'))
sysconfdir = get_option('sysconfdir')
extdatadir = join_paths(datadir, 'gnome-shell', 'extensions', extuuid)

# GSettings schema dir
if get_option('gsettings_schemadir') != ''
  gschemadir = get_option('gsettings_schemadir')
else
  gschemadir = join_paths(datadir, 'glib-2.0', 'schemas')
endif

# GNOME Shell LIBDIR
if get_option('gnome_shell_libdir') != ''
  gnome_shell_libdir = get_option('gnome_shell_libdir')
else
  gnome_shell_libdir = libdir
endif

# Configuration
extconfig = configuration_data()
extconfig.set('VERSION', meson.project_version())
extconfig.set('GNOME_SHELL_LIBDIR', gnome_shell_libdir)
extconfig.set('LOCALEDIR', localedir)
extconfig.set('EXTDATADIR', extdatadir)
extconfig.set('GSCHEMADIR', gschemadir)
extconfig.set('FFMPEG_PATH', get_option('ffmpeg_path'))
extconfig.set('OPENSSL_PATH', get_option('openssl_path'))
extconfig.set('SSHADD_PATH', get_option('sshadd_path'))
extconfig.set('SSHKEYGEN_PATH', get_option('sshkeygen_path'))

# ZIP targets for user extension builds
run_target(
    'make-zip',
    command: [
        find_program('env'),
        'UUID=' + extuuid,
        'DATADIR=' + datadir,
        'LOCALEDIR=' + localedir,
        'GSCHEMADIR=' + gschemadir,
        'meson/mkzip.sh'
    ]
)
run_target(
    'install-zip',
    command: [
        find_program('env'),
        'UUID=' + extuuid,
        'DATADIR=' + datadir,
        'LOCALEDIR=' + localedir,
        'GSCHEMADIR=' + gschemadir,
        'INSTALL=true',
        'meson/mkzip.sh'
    ]
)


# Nautilus/Nemo Extension
if get_option('nautilus')
  install_data(
    'src/nautilus-gsconnect.py',
    install_dir: join_paths(datadir, 'nautilus-python', 'extensions')
  )
endif

if get_option('nemo')
  install_data(
    'src/nautilus-gsconnect.py',
    install_dir: join_paths(datadir, 'nemo-python', 'extensions')
  )
endif


# Extension Source
install_subdir(
  'src',
  install_dir: extdatadir,
  strip_directory: true
)

eslint = find_program('eslint', required: false)

if eslint.found()
  test('ESLint', eslint,
    args: join_paths(meson.build_root(), extuuid)
  )
endif

# Gettext Translations
subdir('data')
subdir('po')

# Post-Install Script for distributions without the hooks
if get_option('post_install')
    meson.add_install_script(
      find_program('env').path(),
      'GSCHEMADIR=' + gschemadir,
      join_paths(meson.source_root(), 'meson/post-install.sh')
    )
endif
