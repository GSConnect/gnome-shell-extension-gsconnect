#!/bin/bash

mkdir -p ${DESTDIR}/etc/opt/chrome/native-messaging-hosts/
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${DESTDIR}/etc/opt/chrome/native-messaging-hosts/org.gnome.shell.extensions.gsconnect.json

mkdir -p ${DESTDIR}/etc/chromium/native-messaging-hosts/
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${DESTDIR}/etc/chromium/native-messaging-hosts/org.gnome.shell.extensions.gsconnect.json
