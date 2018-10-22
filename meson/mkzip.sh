#!/bin/sh

ZIP_DESTDIR="${MESON_BUILD_ROOT}/_zip"
ZIP_DIR="${MESON_BUILD_ROOT}/${UUID}"
ZIP_FILE="${MESON_BUILD_ROOT}/${UUID}.zip"

SFX_FILE="${MESON_BUILD_ROOT}/${UUID}.sfx"

GSCHEMA_DIR="${ZIP_DESTDIR}/${GSCHEMADIR}"
LOCALE_DIR="${ZIP_DESTDIR}/${LOCALEDIR}"

SFX_CMD="#!/bin/sh
sed -e '1,/^exit$/d' \"\$0\" > /tmp/gsconnect.zip
mkdir -p ~/.local/share/gnome-shell/extensions
rm -rf ~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io
unzip /tmp/gsconnect.zip -d ~/.local/share/gnome-shell/extensions/gsconnect@andyholmes.github.io
rm /tmp/gsconnect.zip
exit"

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

echo
echo "Extension saved to ${ZIP_FILE}"

# SELF EXTRACTOR
if [ "$SFX" = true ]; then
    echo "$SFX_CMD" > "${SFX_FILE}"
    cat ${ZIP_FILE} >> "${SFX_FILE}"
    chmod a+x ${SFX_FILE}

    echo "Installer saved to $SFX_FILE"
fi

# INSTALL
if [ "$INSTALL" = true ]; then
    INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
    rm -rf ${INSTALL_DIR}
    unzip ${ZIP_FILE} -d ${INSTALL_DIR}

    echo "Extension installed to $INSTALL_DIR"
fi

