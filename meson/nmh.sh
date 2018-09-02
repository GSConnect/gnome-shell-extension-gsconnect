#!/bin/bash

DESTDIR_SYSCONFDIR=${DESTDIR}/${1}

mkdir -p ${DESTDIR_SYSCONFDIR}/opt/chrome/native-messaging-hosts/
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${DESTDIR_SYSCONFDIR}/opt/chrome/native-messaging-hosts/org.gnome.shell.extensions.gsconnect.json

mkdir -p ${DESTDIR_SYSCONFDIR}/chromium/native-messaging-hosts/
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${DESTDIR_SYSCONFDIR}/chromium/native-messaging-hosts/org.gnome.shell.extensions.gsconnect.json
