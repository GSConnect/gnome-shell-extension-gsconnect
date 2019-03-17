#!/bin/sh

ZIP_DESTDIR="${MESON_BUILD_ROOT}/_zip"
ZIP_DIR="${MESON_BUILD_ROOT}/${UUID}"
ZIP_FILE="${MESON_BUILD_ROOT}/${UUID}.zip"
SFX_FILE="${MESON_BUILD_ROOT}/${UUID}.sfx"

GSCHEMA_DIR="${ZIP_DESTDIR}/${GSCHEMADIR}"
LOCALE_DIR="${ZIP_DESTDIR}/${LOCALEDIR}"

# PRE-CLEAN
rm -rf ${ZIP_DESTDIR} ${ZIP_DIR} ${ZIP_FILE}

# BUILD
cd ${MESON_BUILD_ROOT}
DESTDIR=${ZIP_DESTDIR} ninja install

# COPY
mkdir -p ${ZIP_DIR}
cp -pr ${ZIP_DESTDIR}/${DATADIR}/gnome-shell/extensions/${UUID}/* ${ZIP_DIR}

cp -pr ${GSCHEMA_DIR} ${ZIP_DIR}
glib-compile-schemas ${ZIP_DIR}/schemas

if [ -d ${LOCALE_DIR} ]; then
    cp -pr ${LOCALE_DIR} ${ZIP_DIR}
fi

# COMPRESS
cd ${ZIP_DIR}
zip -qr ${ZIP_FILE} .
cd ${MESON_BUILD_ROOT}
rm -rf _zip

echo
echo "Extension saved to ${ZIP_FILE}"

# INSTALL
if [ "$INSTALL" = true ]; then
    EXTENSIONS_DIR="${HOME}/.local/share/gnome-shell/extensions"
    INSTALL_DIR="${EXTENSIONS_DIR}/${UUID}"

    mkdir -p ${EXTENSIONS_DIR}
    rm -rf ${INSTALL_DIR}
    unzip ${ZIP_FILE} -d ${INSTALL_DIR}

    echo "Extension installed to $INSTALL_DIR"
fi

