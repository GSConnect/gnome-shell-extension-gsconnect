#!/bin/sh

# Use DESTDIR if defined
if [ -n "${DESTDIR}" ]; then
    CHROME_NMHDIR=${DESTDIR}/${1}
else
    CHROME_NMHDIR=${1}
fi

mkdir -p ${CHROME_NMHDIR}
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${CHROME_NMHDIR}/org.gnome.shell.extensions.gsconnect.json


# Use DESTDIR if defined
if [ -n "${DESTDIR}" ]; then
    CHROMIUM_NMHDIR=${DESTDIR}/${2}
else
    CHROMIUM_NMHDIR=${2}
fi

mkdir -p ${CHROMIUM_NMHDIR}
cp ${MESON_BUILD_ROOT}/org.gnome.shell.extensions.gsconnect.json-chrome \
   ${CHROMIUM_NMHDIR}/org.gnome.shell.extensions.gsconnect.json

