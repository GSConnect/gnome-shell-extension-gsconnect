# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

# AppStream MetaInfo
metainfo_file = i18n.merge_file(
  input: app_id + '.metainfo.xml.in',
  output: app_id + '.metainfo.xml',
  po_dir: '../../po',
  install: true,
  install_dir: join_paths(datadir, 'metainfo'),
)

appstream = find_program('appstreamcli', required: false)

if appstream.found()
  test('Validate metainfo file', appstream,
    args: ['validate', '--no-net', '--pedantic', metainfo_file],
    suite: 'data',
  )
endif

