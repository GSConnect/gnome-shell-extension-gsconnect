component_tests_execdir = join_paths(installed_tests_execdir, 'components')
component_tests_metadir = join_paths(installed_tests_metadir, 'components')

# Component Suites
component_tests = [
  'ClipboardComponent',
  # 'ContactsComponent',
  # 'InputComponent',
  'MprisComponent',
  # 'NotificationComponent',
  # 'PulseaudioComponent',
  # 'SessionComponent',
  # 'SoundComponent',
  # 'UpowerComponent',
]


foreach test : component_tests
  test_file = files('test@0@.js'.format(test))

  test(test, minijasmine,
        args: [test_file],
     depends: [installed_tests_prepared],
         env: test_env,
    protocol: 'tap',
       suite: 'components'
  )

  if get_option('installed_tests')
    test_config = configuration_data()
    test_config.set('jasmine_path', minijasmine_path)
    test_config.set('name', 'test@0@.js'.format(test))
    test_config.set('installed_tests_execdir', component_tests_execdir)

    test_description = configure_file(
      configuration: test_config,
              input: join_paths(installed_tests_srcdir, 'jasmine.test.in'),
             output: 'test@0@.test'.format(test),
        install_dir: component_tests_metadir,
    )

    install_data(test_file,
      install_dir: component_tests_execdir,
    )
  endif
endforeach

