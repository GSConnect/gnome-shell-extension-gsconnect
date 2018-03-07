#!/bin/bash

# A script for building GSConnect WebExtension zips for Chrome or Firefox.
# TODO: require 'web-ext'

# Build Mozilla Firefox WebExtension
# requires 'web-ext'
if [ "${1}" != "firefox" ] && [ "${1}" != "chrome" ]; then
    echo "Usage: mkzip [firefox|chrome]"
    exit
fi

# Clean-up old files
rm -rf ${1}.zip

# Copy relevant files
mkdir ${1}

mkdir ${1}/images
cp -R js ${1}/
cp -R _locales ${1}/
cp background.html ${1}/
cp manifest.${1}.json ${1}/manifest.json
cp popup.html ${1}/
cp stylesheet.css ${1}/

if [ "${1}" == "firefox" ]; then
    # Firefox only needs SVG
    cp -R images/*.svg ${1}/images

    # Make the ZIP
    ~/node_modules/.bin/web-ext -s ${1} build
    mv web-ext-artifacts/gsconnect-*.zip ${1}.zip

    # Cleanup
    rm -rf ${1} web-ext-artifacts

# Build Google Chrome/Chromium WebExtension
elif [ "${1}" == "chrome" ]; then
    echo "CHROME"

    # Chrome needs SVG and PNG
    cp -R images/* ${1}/images/

    # Make the ZIP
    cd chrome/
    zip -r ../chrome.zip *

    # Cleanup
    cd ..
    rm -rf ${1}
fi

echo "Successfully built '${1}.zip'"
