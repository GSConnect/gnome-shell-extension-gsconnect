#!/bin/bash

ZIP_DIR="${MESON_BUILD_ROOT}/${1}"
ZIP_FILE="${MESON_BUILD_ROOT}/${1}.zip"

INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${1}"
GSCHEMA_DIR="${ZIP_DIR}/usr/local/share/glib-2.0/schemas"
LOCALE_DIR="${ZIP_DIR}/usr/local/share/locale"

# BUILD
rm -rf ${ZIP_DIR} ${ZIP_FILE}
cd ${MESON_BUILD_ROOT}
DESTDIR=${ZIP_DIR} ninja install

# COPY
cp -pr ${ZIP_DIR}/usr/local/share/gnome-shell/extensions/${1}/* ${ZIP_DIR}

glib-compile-schemas ${ZIP_DIR}/schemas

if [ -d ${ZIP_DIR}/usr/local/share/locale ]; then
    cp -pr ${LOCALE_DIR} ${ZIP_DIR}
fi

rm -rf "${ZIP_DIR}/usr"

# COMPRESS
cd ${ZIP_DIR}
zip -qr ${ZIP_FILE} .

# INSTALL
if [[ ${2} == "install" ]]; then
    rm -rf ${INSTALL_DIR}
    unzip ${ZIP_FILE} -d ${INSTALL_DIR}
fi

