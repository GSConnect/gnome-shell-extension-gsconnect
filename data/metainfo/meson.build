# AppStream MetaInfo
metainfo_file = configure_file(
  input: app_id + '.metainfo.xml.in',
  output: app_id + '.metainfo.xml',
  configuration: extconfig,
  install_dir: join_paths(datadir, 'metainfo')
)

appstream = find_program('appstreamcli', required: false)

if appstream.found()
  test('validate metainfo file', appstream,
    args: ['validate', '--no-net', '--pedantic', metainfo_file]
  )
endif

