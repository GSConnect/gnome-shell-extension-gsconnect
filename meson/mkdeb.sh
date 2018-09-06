#!/bin/bash

# CHECK
if ! [ -x "$(command -v checkinstall)" ]; then
    echo "ERROR: failed to find checkinstall"
    exit 1
fi

# AUTHENTICATE
if [ "$(sudo -p 'Authentication Required: ' whoami)" != "root" ]; then
    exit 1
fi

# PREPARE
meson --prefix /usr \
      --libdir lib \
      . _pkg

# ARGV
CHECKINSTALL='\
echo | checkinstall --type=debian \
                    --pkgname=gnome-shell-extension-gsconnect \
                    --pkgversion=VERSION \
                    --pkgrelease=git \
                    --pkglicense=GPL-2 \
                    --pkggroup=gnome \
                    --pkgarch=all \
                    --requires=gjs,gnome-shell,python3,sshfs,libglib2.0-dev,gir1.2-folks-0.6,libfolks-eds25,python-nautilus,gir1.2-nautilus-3.0,gir1.2-gsound-1.0 \
                    --maintainer="Andy Holmes \<andrew.g.r.holmes@gmail.com\>" \
                    --backup=no \
                    --install=INSTALL \
                    --nodoc \
                    --exclude=$(pwd)/_build \
       ninja -C _pkg install \
'
CHECKINSTALL=${CHECKINSTALL/VERSION/$VERSION}
CHECKINSTALL=${CHECKINSTALL/INSTALL/$INSTALL}

# BUILD/INSTALL
printf 'Building DEB...'
sudo sh -c "${CHECKINSTALL}" > /dev/null 2>&1
echo 'done'

# CLEANUP
USER_NAME=$(whoami)
sudo rm -rf _pkg
sudo chown ${USER_NAME}.${USER_NAME} *.deb

