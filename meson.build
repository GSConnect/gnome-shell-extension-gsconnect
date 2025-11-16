project('gsconnect',
  'c',
  version: '68',
  meson_version: '>= 0.46.0'
)

gnome = import('gnome')
i18n = import('i18n')

app_id = 'org.gnome.Shell.Extensions.GSConnect'
app_path = '/org/gnome/Shell/Extensions/GSConnect'
extuuid = 'gsconnect@andyholmes.github.io'

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
extdatadir = join_paths(datadir, 'gnome-shell', 'extensions', extuuid)
libdir = join_paths(prefix, get_option('libdir'))
libexecdir = join_paths(prefix, get_option('libexecdir'))
localedir = join_paths(prefix, get_option('localedir'))
sysconfdir = get_option('sysconfdir')


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
extconfig.set('PACKAGE_VERSION', meson.project_version())
extconfig.set('PACKAGE_URL', 'https://github.com/GSConnect/gnome-shell-extension-gsconnect')
extconfig.set('PACKAGE_BUGREPORT', 'https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/new')
extconfig.set('PACKAGE_DATADIR', extdatadir)
extconfig.set('PACKAGE_LOCALEDIR', localedir)
extconfig.set('GSETTINGS_SCHEMA_DIR', gschemadir)

extconfig.set('APPLICATION_ID', app_id)
extconfig.set('APPLICATION_PATH', app_path)

extconfig.set('GNOME_SHELL_LIBDIR', gnome_shell_libdir)
extconfig.set('FFMPEG_PATH', get_option('ffmpeg_path'))
extconfig.set('OPENSSL_PATH', get_option('openssl_path'))
extconfig.set('SSHADD_PATH', get_option('sshadd_path'))
extconfig.set('SSHKEYGEN_PATH', get_option('sshkeygen_path'))


# ZIP targets for user extension builds
env_util = find_program('env')

run_target(
  'make-pkgdir',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    'NOZIP=true',
    join_paths(meson.project_source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)

run_target(
  'make-zip',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    join_paths(meson.source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)

run_target(
  'install-zip',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    'INSTALL=true',
    join_paths(meson.source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)


# Post-Install script for distributions without the hooks
if get_option('post_install')
    meson.add_install_script(
      env_util.path(),
      'GSCHEMADIR=' + gschemadir,
      join_paths(meson.source_root(), 'build-aux', 'meson', 'post-install.sh')
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
  test('ESLint (Source)', eslint,
    args: join_paths(meson.source_root(), 'src'),
    suite: 'lint',
  )
  test('ESLint (Installed Tests)', eslint,
    args: join_paths(meson.source_root(), 'installed-tests'),
    suite: 'lint',
  )
  test('ESLint (WebExtension)', eslint,
    args: join_paths(meson.source_root(), 'webextension'),
    suite: 'lint',
  )
endif


subdir('data')
subdir('installed-tests')
subdir('nautilus-extension')
subdir('po')
