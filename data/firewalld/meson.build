# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

# firewalld Configuration
if get_option('firewalld')
  install_data(
    'gsconnect.xml',
    install_dir: join_paths(libdir, 'firewalld', 'services')
  )
endif

