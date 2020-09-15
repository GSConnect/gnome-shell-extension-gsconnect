#!/bin/bash

APP_ID="org.gnome.Shell.Extensions.GSConnect"
#G_TEST_BUILDDIR=${MESON_BUILD_ROOT}/installed-tests

# Copy source files
cp -R ${MESON_SOURCE_ROOT}/src ${G_TEST_BUILDDIR}
cp ${G_TEST_BUILDDIR}/config.js ${G_TEST_BUILDDIR}/src

# Compile GResources
glib-compile-resources --external-data \
                       --sourcedir=${MESON_BUILD_ROOT}/data \
                       --sourcedir=${MESON_SOURCE_ROOT}/data \
                       --target=${G_TEST_BUILDDIR}/src/${APP_ID}.gresource \
                       ${MESON_SOURCE_ROOT}/data/${APP_ID}.gresource.xml

# Compile GSettings Schema
glib-compile-schemas --targetdir=${G_TEST_BUILDDIR} \
                     ${MESON_SOURCE_ROOT}/data

