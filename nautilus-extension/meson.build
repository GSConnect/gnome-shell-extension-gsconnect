# Nautilus Extension
if get_option('nautilus')
  install_data(
    'nautilus-gsconnect.py',
    install_dir: join_paths(datadir, 'nautilus-python', 'extensions')
  )
endif

# Nemo Extension
if get_option('nemo')
  install_data(
    'nautilus-gsconnect.py',
    rename: join_paths(datadir, 'nemo-python', 'extensions', 'nemo-gsconnect.py')
  )
endif

